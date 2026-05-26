/**
 * agents/resume-tailor.js — Resume Tailoring Agent
 * 
 * CRITICAL RULE: This agent NEVER DELETES anything from the base resume.
 * It only APPENDS: new bullets, skill keywords, and summary sentences.
 * 
 * Flow:
 * 1. Load base-resume.json (read-only source of truth)
 * 2. Ask AI to generate APPEND-ONLY patches
 * 3. Apply patches (title update, summary append, bullet append, skill append)
 * 4. Render to PDF via Playwright
 * 5. Upload to Supabase storage
 * 
 * Exports:
 *   - generateTailoredResume(job, context, supabase, fallbackPath) → TailoredResult
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { callGroq, callGemini } from './llm-client.js';
import { ROOT } from './constants.js';

// ── The AI Prompt — APPEND ONLY, NEVER DELETE ────────────────────────────────
const TAILOR_SYSTEM_PROMPT = `You are an expert technical recruiter. APPEND relevant content to the candidate's resume to maximise ATS match. You are STRICTLY FORBIDDEN from changing, deleting, or rewriting any existing content.

RULES:
- Do NOT modify existing bullets, titles, dates, companies, education, certifications, or contact info.
- Do NOT fabricate experience the candidate does not have.
- Only add content that is a truthful extension of existing experience.

Return ONLY valid JSON with these keys:
{
  "title": "Updated headline matching the job title",
  "summary_append": "1-2 sentences to APPEND (not replace) to the existing summary paragraph, linking candidate's experience to this specific role",
  "experience_append": {
    "CompanyName": ["new bullet to append", "optional second bullet"]
  },
  "new_skills": ["skill1", "skill2"]
}

- "experience_append": only include the 1-2 most relevant companies. Each bullet must be a truthful, specific extension of work already described (e.g. if Terraform is listed, add a JD-relevant Terraform bullet).
- "new_skills": 3-8 keywords from the JD the candidate realistically has.
- Return ONLY JSON — no explanation.`;

/**
 * @typedef {object} TailoredResult
 * @property {string} pdfPath - Path to the tailored PDF
 * @property {string|null} publicUrl - Supabase public URL
 * @property {string} changes - Description of changes made
 */

/**
 * Generate a tailored resume for a specific job.
 * NEVER DELETES existing content — only APPENDS.
 * 
 * @param {object} job - Job object with title, company, description
 * @param {import('playwright').BrowserContext} context - Playwright context for PDF rendering
 * @param {object} supabase - Supabase client
 * @param {string} fallbackPath - Path to base resume PDF if tailoring fails
 * @returns {TailoredResult}
 */
export async function generateTailoredResume(job, context, supabase, fallbackPath) {
  const baseJsonPath = join(ROOT, 'resume', 'base-resume.json');
  if (!existsSync(baseJsonPath)) {
    return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };
  }

  console.log(`  🤖 Tailoring resume for ${job.company} - ${job.title}...`);
  const baseJsonStr = readFileSync(baseJsonPath, 'utf8');

  const userPrompt = `Job Title: ${job.title}\nCompany: ${job.company}\nJob Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nCandidate Base Resume JSON:\n${baseJsonStr}`;

  // Deep-clone base so original is never mutated
  let tailoredJson = JSON.parse(baseJsonStr);
  let changesMadeArr = [];

  try {
    console.log(`  🔄 Generating append-only tailored content (Groq)...`);
    let res = await callGroq(TAILOR_SYSTEM_PROMPT, userPrompt);
    // If Groq fails, try Gemini fallback
    if ((!res || res.trim() === '{}') && process.env.GEMINI_API_KEY) {
      console.log(`  🔄 Groq returned empty — retrying with Gemini...`);
      res = await callGemini(TAILOR_SYSTEM_PROMPT, userPrompt);
    }
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');

    const patch = JSON.parse(match[0]);
    if (Object.keys(patch).length === 0) throw new Error('AI returned empty JSON');

    // ── Apply APPEND-ONLY patches ──

    // 1. Headline — update only (visual, not core data)
    if (patch.title && patch.title !== tailoredJson.personal.title) {
      tailoredJson.personal.title = patch.title;
      changesMadeArr.push(`Headline → "${patch.title}"`);
    }

    // 2. Summary — APPEND sentences, NEVER replace
    if (patch.summary_append && patch.summary_append.trim()) {
      const append = patch.summary_append.trim();
      // Avoid duplicating if already appended (idempotent)
      if (!tailoredJson.summary.includes(append.substring(0, 30))) {
        tailoredJson.summary = tailoredJson.summary.trimEnd() + ' ' + append;
        changesMadeArr.push('Appended to summary');
      }
    }

    // 3. Experience — APPEND bullets, NEVER replace or reorder
    if (patch.experience_append && typeof patch.experience_append === 'object') {
      for (const [company, newBullets] of Object.entries(patch.experience_append)) {
        if (!Array.isArray(newBullets) || newBullets.length === 0) continue;
        const expEntry = tailoredJson.experience.find(
          e => e.company.toLowerCase().includes(company.toLowerCase()) ||
               company.toLowerCase().includes(e.company.toLowerCase())
        );
        if (!expEntry) continue;
        const added = [];
        for (const bullet of newBullets) {
          const b = bullet.trim();
          if (!b) continue;
          // Don't add if semantically already covered (dedup)
          const alreadyExists = expEntry.bullets.some(
            existing => existing.toLowerCase().includes(b.substring(0, 25).toLowerCase())
          );
          if (!alreadyExists) {
            expEntry.bullets.push(b);
            added.push(b.substring(0, 50));
          }
        }
        if (added.length > 0) changesMadeArr.push(`+${added.length} bullet(s) @ ${expEntry.company}`);
      }
    }

    // 4. Skills — APPEND a new "Tailored Skills" row, NEVER modify existing
    if (patch.new_skills && Array.isArray(patch.new_skills) && patch.new_skills.length > 0) {
      tailoredJson.skills['Tailored for Role'] = patch.new_skills.join(', ');
      changesMadeArr.push(`+${patch.new_skills.length} tailored skill keywords`);
    }

    tailoredJson.changes_made = changesMadeArr.length > 0
      ? changesMadeArr.join(' | ')
      : 'Base Resume (No modifications)';

    if (changesMadeArr.length === 0) throw new Error('No meaningful changes made');

    // 5. ATS score evaluation
    console.log(`  📊 Evaluating tailored resume...`);
    const scoreRes = process.env.GEMINI_API_KEY
      ? await callGemini(
          'You are a strict ATS. Compare resume to JD. Return JSON: {"score": integer 0-100}',
          `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume:\n${JSON.stringify(tailoredJson)}`
        )
      : await callGroq(
          'You are a strict ATS. Compare resume to JD. Return JSON: {"score": integer 0-100}',
          `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume:\n${JSON.stringify(tailoredJson)}`,
          'llama-3.3-70b-versatile'
        );
    let score = 0;
    try {
      const sm = scoreRes.match(/\{[\s\S]*\}/);
      if (sm) score = JSON.parse(sm[0]).score || 0;
    } catch { score = parseInt(scoreRes.replace(/\D/g, '')) || 0; }
    console.log(`  📈 ATS Score: ${score}%`);

  } catch(e) {
    console.log(`  ⚠️ Tailoring failed (${e.message}), using base resume.`);
    return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };
  }

  // ── Build PDF from tailored JSON ──────────────────────────────────────────
  const templateStr = readFileSync(join(ROOT, 'src', 'scripts', 'resume-template.html'), 'utf8');

  const skillsHtml = Object.entries(tailoredJson.skills || {}).map(([cat, sk]) =>
    `<div class="skill-category">${cat}</div><div>${sk}</div>`
  ).join('');

  const expHtml = (tailoredJson.experience || []).map(exp => `
    <div class="experience-item">
      <div class="exp-header">
        <div><span class="exp-title">${exp.role}</span> | <span class="exp-company">${exp.company}</span></div>
        <div class="exp-date-loc">${exp.date} • ${exp.location || ''}</div>
      </div>
      <ul>${(exp.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul>
    </div>
  `).join('');

  const eduHtml = (tailoredJson.education || []).map(edu => `
    <div class="edu-item">
      <div><span class="edu-degree">${edu.degree}</span>, <span class="edu-school">${edu.school}</span></div>
      <div class="exp-date-loc">${edu.date} • ${edu.location || ''}</div>
    </div>
  `).join('');

  const certsHtml = (tailoredJson.certifications || []).map(c => `<div class="cert-item">${c}</div>`).join('');

  const finalHtml = templateStr
    .replace('{{name}}', tailoredJson.personal?.name || '')
    .replace('{{title}}', tailoredJson.personal?.title || '')
    .replace('{{location}}', tailoredJson.personal?.location || '')
    .replace(/{{email}}/g, tailoredJson.personal?.email || '')
    .replace('{{phone}}', tailoredJson.personal?.phone || '')
    .replace('{{linkedin}}', tailoredJson.personal?.linkedin || '')
    .replace('{{github}}', tailoredJson.personal?.github || '')
    .replace('{{summary}}', tailoredJson.summary || '')
    .replace('{{skills_html}}', skillsHtml)
    .replace('{{experience_html}}', expHtml)
    .replace('{{education_html}}', eduHtml)
    .replace('{{certifications_html}}', certsHtml);

  const outputPath = join(ROOT, 'resume', `tailored_${job.id}.pdf`);
  const pdfPage = await context.newPage();
  await pdfPage.setContent(finalHtml, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: outputPath, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  await pdfPage.close();

  // Upload to Supabase
  let publicUrl = null;
  try {
    const pdfBuffer = readFileSync(outputPath);
    const fileName = `resume_${job.id}_${Date.now()}.pdf`;
    await supabase.storage.from('screenshots').upload(fileName, pdfBuffer, { upsert: true, contentType: 'application/pdf' });
    publicUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
    console.log(`  📎 Tailored resume generated & uploaded`);
  } catch(e) {
    console.error('  ⚠️ Failed to upload tailored resume:', e.message);
  }

  return { pdfPath: outputPath, publicUrl, changes: tailoredJson.changes_made || 'Tailored' };
}
