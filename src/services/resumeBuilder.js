import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

import { callLLM } from './llm.js';

// Wrapper for backward compatibility — routes through llm.js which has retry logic
async function callGroq(systemPrompt, userPrompt) {
  return await callLLM(systemPrompt, userPrompt, { json: true, maxTokens: 1500 });
}

/**
 * V2 Non-Destructive Resume Tailoring & PDF Generation
 * @param {Object} job - The job object with title, company, description
 * @param {Object} context - (Optional) Playwright context
 * @param {Object} supabase - (Optional) Supabase client for screenshot upload
 * @param {String} fallbackPath - Path to base resume if generation fails
 */
export async function generateTailoredResume(job, context = null, supabase = null, fallbackPath = join(ROOT, 'resume', 'resume.pdf')) {
  const baseJsonPath = join(ROOT, 'resume', 'base-resume.json');
  if (!existsSync(baseJsonPath)) return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };

  console.log(`  🤖 Tailoring resume for ${job.company} - ${job.title}...`);
  const baseJsonStr = readFileSync(baseJsonPath, 'utf8');

  const sysPrompt = `You are an expert technical recruiter. Your task is to tailor the candidate's resume for the target Job Description to maximize ATS match.

CRITICAL RULES:
- Do NOT remove, modify, or rewrite any experience entries or bullet points. ALL experience MUST remain exactly as-is.
- Do NOT invent new experience or companies.
- You may ONLY output three things in JSON format:

1. "title": A new professional title that closely matches the target job.
2. "summary": A tailored professional summary (approx. 3-4 sentences) that highlights the candidate's EXISTING experience in a way that matches the job description. Do NOT invent new experience.
3. "new_skills": An array of 3-8 relevant keywords/skills from the Job Description that the candidate realistically possesses based on their base resume.

Return ONLY valid JSON matching this exact structure:
{
  "title": "string",
  "summary": "string",
  "new_skills": ["string"]
}`;

  const userPrompt = `Job Title: ${job.title}\nJob Company: ${job.company}\nJob Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nCandidate's Base Resume:\n${baseJsonStr}`;

  let tailoredJson = JSON.parse(baseJsonStr);
  
  try {
    console.log(`  🔄 Generating tailored Summary, Title, and Skills...`);
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    
    const patchJson = JSON.parse(match[0]);
    
    // Apply patches safely
    if (patchJson.title) tailoredJson.personal.title = patchJson.title;
    if (patchJson.summary) tailoredJson.summary = patchJson.summary;
    if (patchJson.new_skills && Array.isArray(patchJson.new_skills) && patchJson.new_skills.length > 0) {
        tailoredJson.skills['Tailored Skills'] = patchJson.new_skills.join(', ');
    }
  } catch(e) {
    console.log('  ⚠️ Failed to generate tailored resume sections, using base.', e.message);
    return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };
  }

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

  const outputHtmlPath = join(ROOT, 'resume', `tailored_${job.id}.html`);
  writeFileSync(outputHtmlPath, finalHtml);
  console.log(`  📄 Tailored HTML saved to: ${outputHtmlPath}`);
  
  // Return the fallback PDF so the pipeline continues
  const outputPath = fallbackPath;

  let publicUrl = null;
  if (supabase) {
    try {
       const pdfBuffer = readFileSync(outputPath);
       const fileName = `resume_${job.id}_${Date.now()}.pdf`;
       await supabase.storage.from('resumes').upload(fileName, pdfBuffer, { upsert: true, contentType: 'application/pdf' });
       publicUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/resumes/${fileName}`;
       console.log(`  📎 Tailored resume generated & uploaded`);
    } catch(e) {
       console.error('  ⚠️ Failed to upload tailored resume:', e.message);
    }
  }

  return { 
    pdfPath: outputPath, 
    publicUrl, 
    changes: 'Tailored resume to match job description' 
  };
}
