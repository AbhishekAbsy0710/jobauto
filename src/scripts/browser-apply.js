#!/usr/bin/env node
/**
 * Playwright Browser Auto-Apply (AI Powered)
 * Dynamically fills out forms using Groq API
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
chromium.use(stealth());
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RESUME_PATH = join(ROOT, 'resume', 'resume.pdf');

// Load .env
try {
  const envFile = readFileSync(join(ROOT, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const PROFILE_YAML = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8').substring(0, 2000);

const PROFILE = {
  firstName: 'Abhishek Raj',
  lastName: 'Pagadala',
  fullName: 'Abhishek Raj Pagadala',
  email: process.env.APPLICANT_EMAIL || 'pagadalaabhishek60@gmail.com',
  phone: process.env.APPLICANT_PHONE || '+49 176 6723 9250',
  linkedin: 'https://www.linkedin.com/in/abhishek-raj-pagadala',
  city: 'Munich',
  country: 'Germany',
};

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

async function sendDiscordEmbed(embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
  } catch {}
}

async function callGroq(systemPrompt, userPrompt, model = 'llama-3.1-8b-instant') {
  if (!process.env.GROQ_API_KEY) return '{}';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.log(`  ⚠️ Groq API Error (${model}): ${res.status} - ${errText}`);
    
    // 413 Request too large — try fallback model or return empty
    if (res.status === 413) {
      if (model === 'llama-3.1-8b-instant') {
        console.log(`  🔄 Request too large for 8b, trying 70b...`);
        return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
      }
      console.log(`  ⚠️ Request too large even for 70b, skipping...`);
      return '{}';
    }
    
    // TPD limit reached for primary 8b, switch to 70b fallback
    if (res.status === 429 && model === 'llama-3.1-8b-instant' && errText.includes('TPD')) {
      console.log(`  🔄 Retrying with fallback model: llama-3.3-70b-versatile`);
      return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
    }
    
    // TPD limit reached for fallback 70b too, switch back to 8b with wait
    if (res.status === 429 && model === 'llama-3.3-70b-versatile' && errText.includes('TPD')) {
      console.log(`  ⚠️ Both models hit TPD limit. Skipping...`);
      return '{}';
    }
    
    // TPM limit reached, wait and retry
    if (res.status === 429 && errText.includes('TPM')) {
      const waitMatch = errText.match(/try again in ([\d\.]+)s/);
      const waitTime = waitMatch ? (parseFloat(waitMatch[1]) * 1000) + 1000 : 15000;
      console.log(`  ⏳ TPM limit hit. Waiting ${Math.round(waitTime/1000)}s before retry...`);
      await new Promise(r => setTimeout(r, waitTime));
      return await callGroq(systemPrompt, userPrompt, model);
    }
    
    return '{}';
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '{}';
}

// ============================================
// AI FORM FILLER
// ============================================
async function fillDynamicFields(page) {
  const fields = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    return inputs.map(el => {
      const name = (el.name || el.id || '').toLowerCase();
      // Skip fields we likely already hardcoded
      if (name.includes('name') || name.includes('email') || name.includes('phone') || el.type === 'file' || el.type === 'submit') return null;
      if (el.disabled) return null;

      let labelText = '';
      if (el.labels && el.labels.length > 0) {
        labelText = Array.from(el.labels).map(l => l.innerText).join(' ');
      } else {
        const parent = el.closest('.field, .form-group, div');
        if (parent) labelText = parent.innerText.split('\\n')[0];
      }

      let options = [];
      if (el.tagName === 'SELECT') {
        options = Array.from(el.querySelectorAll('option'))
                       .filter(o => o.innerText.trim() && o.innerText.trim() !== 'Select...')
                       .map(o => ({ value: o.value || o.innerText.trim(), label: o.innerText.trim() }));
      } else if (el.type === 'radio' || el.type === 'checkbox') {
        let text = el.value;
        const next = el.nextElementSibling;
        if (next && next.tagName === 'LABEL') text = next.innerText.trim();
        else if (el.parentElement && el.parentElement.tagName === 'LABEL') {
           const clone = el.parentElement.cloneNode(true);
           const inputs = clone.querySelectorAll('input');
           inputs.forEach(i => i.remove());
           text = clone.innerText.trim() || el.value;
        }
        options = [{ value: el.value, label: text }];
      }

      return {
        id: el.id || '',
        name: el.name || el.id || '',
        type: el.type || el.tagName.toLowerCase(),
        label: labelText.substring(0, 150).replace(/\s+/g, ' ').trim(),
        options: options.slice(0, 20)
      };
    }).filter(f => f && f.label && f.name); // must have name or id to target
  });

  if (fields.length === 0) return;

  // Group radio buttons
  const grouped = {};
  for (const f of fields) {
    if (!grouped[f.name]) grouped[f.name] = { name: f.name, label: f.label, type: f.type, options: [] };
    if (f.options.length > 0) grouped[f.name].options.push(...f.options);
  }

  const questions = Object.values(grouped);
  if (questions.length === 0) return;

  console.log(`  🤖 AI reading ${questions.length} custom fields...`);

const sysPrompt = `You are an AI filling out a job application. Use the candidate's profile to answer the custom questions.
PROFILE CONTEXT:
${PROFILE_YAML}
Candidate LinkedIn: ${PROFILE.linkedin}

Return JSON strictly in this format:
{"answers": [{"name": "input_name_attribute", "value": "your_answer", "type": "text|select|radio|checkbox"}]}

CRITICAL RULES FOR FILLING OUT FORMS WITHOUT MISTAKES:
- NEVER leave a required field blank if it is in the list.
- For 'select', 'radio', or 'checkbox', your 'value' MUST exactly match the 'value' field of the option you choose (NOT the label). Do not make up values.
- Visa/Sponsorship: Always answer strictly "No" or "I do not require sponsorship" (unless applying inside Germany where you might not need it).
- Notice Period: Always answer "1 month" or "4 weeks" or "Immediate" depending on the options.
- Salary Expectations: Put "55000" (or 55,000 depending on the form).
- Disability/Veteran: Always answer "Decline to answer", "Prefer not to say", or "No".
- If a question appears to be a Yes/No question (e.g. "Are you open to...", "Do you have..."), STRICTLY answer exactly "Yes" or "No" unless you are 100% sure the dropdown options are different.
- If the question asks for a link (LinkedIn/GitHub/Portfolio), you MUST use exactly the URL provided above. ALWAYS include https:// otherwise the form will fail validation.
- DO NOT use actual newlines inside the JSON strings. Use literal "\\n" if you must break lines. Unescaped newlines will break the JSON parser.
- Escape all double quotes inside your answers using \\"`;

  const userPrompt = `Form Fields:\n` + JSON.stringify(questions, null, 2);

  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    
    // Fix common unescaped newlines in JSON strings before parsing
    let jsonString = match[0];
    // This is a basic cleanup to prevent JSON.parse from failing on unescaped newlines within values
    jsonString = jsonString.replace(/(?<=:\s*")(.*?)(?="(?:\s*\}|\s*,))/gs, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, ''));

    const data = JSON.parse(jsonString);
    if (!data.answers) {
      console.log(`  ⚠️ AI fill error: No 'answers' array in JSON. Raw data: ${JSON.stringify(data).substring(0, 200)}`);
      return;
    }

    for (const ans of data.answers) {
      try {
        const selector = ans.name.includes('question_') ? `[id="${ans.name}"], [name="${ans.name}"]` : `[name="${ans.name}"], [id="${ans.name}"]`;
        if (ans.type === 'radio' || ans.type === 'checkbox') {
          // Find the exact radio/checkbox by value
          const specificSelector = `${selector}[value="${ans.value}"]`;
          await page.click(specificSelector, { timeout: 1000, force: true }).catch(async () => {
             // Fallback if value isn't exact
             const els = await page.$$(selector);
             if (els.length > 0) await els[0].check({ force: true }).catch(()=>{});
          });
        } else if (ans.type === 'select' || ans.type === 'select-one') {
          await page.selectOption(selector, { value: ans.value }, { force: true }).catch(() => page.selectOption(selector, { label: ans.value }, { force: true }));
        } else {
          // Check if it's actually a select
          const isSelect = await page.$eval(selector, el => el.tagName === 'SELECT').catch(()=>false);
          if (isSelect) {
            await page.selectOption(selector, { value: ans.value }, { force: true }).catch(() => page.selectOption(selector, { label: ans.value }, { force: true }));
          } else {
            const el = await page.$(selector);
            if (el) {
               // Check if it's a React Select combobox
               const className = await el.getAttribute('class') || '';
               const role = await el.getAttribute('role') || '';
               if (className.includes('select__input') || className.includes('react-select') || role === 'combobox') {
                  await fillReactSelect(page, el, ans.value);
               } else {
                  await el.fill(ans.value, { force: true });
               }
            }
          }
        }
        console.log(`    ↳ Filled ${ans.name} -> ${ans.value.substring(0, 50)}${ans.value.length > 50 ? '...' : ''}`);
      } catch (e) {
        console.log(`    ↳ ⚠️ Failed to fill ${ans.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️ AI fill error: ${e.message}`);
  }
}

// ============================================
// COOKIE BANNER DISMISSAL
// ============================================
async function dismissCookieBanners(page) {
  const cookieSelectors = [
    'button:has-text("Accept")', 'button:has-text("Accept All")', 'button:has-text("Accept all")',
    'button:has-text("Agree")', 'button:has-text("Got it")', 'button:has-text("OK")',
    'button:has-text("I agree")', 'button:has-text("Allow all")',
    'button[id*="cookie"] >> text=Accept', 'button[id*="consent"] >> text=Accept',
    '#onetrust-accept-btn-handler', '.cookie-consent-accept', '#cookie-accept',
    '[data-testid="cookie-accept"]', '.cc-accept', '.cc-btn.cc-allow',
  ];
  for (const sel of cookieSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click({ timeout: 2000 });
        console.log('  🍪 Dismissed cookie banner');
        await page.waitForTimeout(500);
        break;
      }
    } catch {}
  }
}

// ============================================
// DEMOGRAPHIC SURVEY FIELDS (hard-coded to avoid AI hallucination)
// ============================================
async function fillDemographicFields(page) {
  // Gender
  const genderSelectors = [
    'select[name*="gender"], select[id*="gender"]',
    'select[name*="Gender"], select[id*="Gender"]',
  ];
  for (const sel of genderSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await page.selectOption(sel, { label: 'Decline to self-identify' }).catch(() =>
          page.selectOption(sel, { label: 'Prefer not to say' }).catch(() =>
            page.selectOption(sel, { label: 'I do not wish to answer' }).catch(() => {})
          )
        );
      }
    } catch {}
  }

  // Veteran status
  const vetSelectors = ['select[name*="veteran"], select[id*="veteran"]', 'select[name*="Veteran"], select[id*="Veteran"]'];
  for (const sel of vetSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await page.selectOption(sel, { label: 'I am not a protected veteran' }).catch(() =>
          page.selectOption(sel, { label: 'I don\'t wish to answer' }).catch(() => {})
        );
      }
    } catch {}
  }

  // Disability
  const disSelectors = ['select[name*="disability"], select[id*="disability"]', 'select[name*="Disability"], select[id*="Disability"]'];
  for (const sel of disSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await page.selectOption(sel, { label: 'I don\'t wish to answer' }).catch(() =>
          page.selectOption(sel, { label: 'Prefer not to say' }).catch(() => {})
        );
      }
    } catch {}
  }

  // Race/ethnicity
  const raceSelectors = ['select[name*="race"], select[id*="race"], select[name*="ethnicity"], select[id*="ethnicity"]'];
  for (const sel of raceSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await page.selectOption(sel, { label: 'Decline to self-identify' }).catch(() =>
          page.selectOption(sel, { label: 'I don\'t wish to answer' }).catch(() => {})
        );
      }
    } catch {}
  }
}

// ============================================
// REACT SELECT HELPER: Click to open, read options, click to select
// ============================================
async function fillReactSelect(page, inputElement, desiredValue) {
  try {
    // Click the dropdown control to open it
    const control = await inputElement.evaluateHandle(el => el.closest('.select__control') || el.closest('[class*="-control"]') || el.parentElement?.parentElement);
    await control.click();
    await page.waitForTimeout(400);

    // Read all available options
    const options = await page.$$eval('[id*="-option-"]', els => els.map(el => ({
      text: el.innerText.trim(),
      id: el.id
    })));

    if (options.length === 0) {
      // Fallback: type and press enter
      await inputElement.type(desiredValue, { delay: 50 });
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
      await page.keyboard.press('Enter');
      return;
    }

    // Find best matching option (case-insensitive partial match)
    const valueLower = desiredValue.toLowerCase();
    let bestMatch = options.find(o => o.text.toLowerCase() === valueLower)
      || options.find(o => o.text.toLowerCase().includes(valueLower))
      || options.find(o => valueLower.includes(o.text.toLowerCase()))
      || options[0]; // fallback to first option

    // Click the matching option element
    if (bestMatch) {
      await page.click(`#${bestMatch.id}`);
      await page.waitForTimeout(200);
    }
  } catch (e) {
    // Ultimate fallback: type and press enter
    try {
      await inputElement.focus();
      await inputElement.type(desiredValue, { delay: 50 });
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
    } catch {}
  }
}

// ============================================
// BASE FORM FILLER
// ============================================
async function fillBaseFields(page, resumePath) {
  // Prevent links from opening in a new tab so we stay on the same page
  await page.evaluate(() => {
    document.querySelectorAll('a').forEach(a => a.removeAttribute('target'));
  }).catch(() => {});

  // Try to click any initial "Apply" buttons if it's Lever/Generic
  const applyBtns = await page.$$('a:has-text("Apply for this job"), button:has-text("Apply"), a.apply-button, .apply-btn');
  for (const btn of applyBtns) {
    try { await btn.click({ timeout: 2000 }); await page.waitForTimeout(2000); break; } catch {}
  }

  // Name
  await fillField(page, '#first_name, input[name="first_name"], input[name*="first"]', PROFILE.firstName);
  await fillField(page, '#last_name, input[name="last_name"], input[name*="last"]', PROFILE.lastName);
  await fillField(page, 'input[name="name"], input[name="cards[0][field0]"]', PROFILE.fullName); // Lever

  // Email & Phone
  await fillField(page, '#email, input[name="email"], input[type="email"]', PROFILE.email);
  await fillField(page, '#phone, input[name="phone"], input[type="tel"]', PROFILE.phone);

  // Socials / Location
  await fillField(page, 'input[name*="linkedin"], input[id*="linkedin"]', PROFILE.linkedin);
  await fillField(page, 'input[name*="location"], input[id*="location"], input[placeholder*="City"]', PROFILE.city);

  // Resume
  if (existsSync(resumePath)) {
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const accept = await input.getAttribute('accept') || '';
        const name = await input.getAttribute('name') || '';
        if (accept.includes('pdf') || name.includes('resume') || name.includes('cv') || fileInputs.length === 1) {
          await input.setInputFiles(resumePath);
          console.log('  📎 Resume uploaded');
          break;
        }
      }
    } catch (e) {}
  }
}

async function fillField(page, selector, value) {
  try {
    const field = await page.$(selector);
    if (field && await field.isVisible()) {
      await field.click();
      await field.fill(value);
      return true;
    }
  } catch {}
  return false;
}

// ============================================
// DYNAMIC RESUME TAILORING
// ============================================
async function generateTailoredResume(job, context, supabase, fallbackPath) {
  const baseJsonPath = join(ROOT, 'resume', 'base-resume.json');
  if (!existsSync(baseJsonPath)) return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };

  console.log(`  🤖 Tailoring resume for ${job.company} - ${job.title}...`);
  const baseJsonStr = readFileSync(baseJsonPath, 'utf8');

  const sysPrompt = `You are an expert technical recruiter. Your task is to tailor the candidate's resume for the target Job Description to maximize ATS match.
To prevent hallucinations or loss of data, you are ONLY allowed to output three things in JSON format:
1. "title": A new professional title that closely matches the target job.
2. "summary": A tailored professional summary (approx. 3-4 sentences) that highlights the candidate's existing experience in a way that matches the job description. Do NOT invent new experience.
3. "new_skills": An array of strings containing 3 to 8 relevant keywords/skills from the Job Description that the candidate realistically possesses based on their base resume.

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
        // Append new skills to the first category, or create an 'Added Skills' category
        tailoredJson.skills['Tailored Skills'] = patchJson.new_skills.join(', ');
    }
    
    // Evaluate the new tailored resume
    console.log(`  📊 Evaluating tailored resume...`);
    const evalSysPromptJson = `You are a strict ATS (Applicant Tracking System). Compare the Candidate's Resume against the Job Description. Return a JSON object with a single key "score" containing an integer from 0 to 100 representing the match percentage.`;
    const evalUserPrompt = `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume JSON:\n${JSON.stringify(tailoredJson)}`;
    const scoreRes = await callGroq(evalSysPromptJson, evalUserPrompt, 'llama-3.1-8b-instant');
    let score = 0;
    try {
        score = JSON.parse(scoreRes.match(/\{[\s\S]*\}/)[0]).score || 0;
    } catch(err) {
        score = parseInt(scoreRes.replace(/\D/g, '')) || 0;
    }
    console.log(`  📈 ATS Score: ${score}%`);
    
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

  const outputPath = join(ROOT, 'resume', `tailored_${job.id}.pdf`);
  const pdfPage = await context.newPage();
  await pdfPage.setContent(finalHtml, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: outputPath, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  await pdfPage.close();

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

  return { pdfPath: outputPath, publicUrl, changes: tailoredJson.changes_made || 'Tailored resume to match job description' };
}

// ============================================
// MAIN
// ============================================
async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  const { data: rawJobs, error } = await supabase
    .from('jobs')
    .select('*, evaluations!inner(id, letter_grade, weighted_score)')
    .eq('status', 'auto_queue');

  if (error || !rawJobs || rawJobs.length === 0) {
    console.log('📭 No jobs in the apply queue');
    return;
  }

  let jobs = rawJobs.map(j => {
    const e = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
    return { ...j, eval_id: e.id, grade: e.letter_grade, score: e.weighted_score };
  }).sort((a, b) => b.score - a.score);

  console.log(`\n🚀 Auto-applying to ${jobs.length} jobs via Playwright (AI Enabled)...\n`);

  const browser = await chromium.launch({ headless: true, slowMo: 100, timeout: 30000 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  
  // Set a reasonable timeout — 8s is more robust for async form rendering
  context.setDefaultTimeout(8000);

  const results = { applied: 0, failed: 0, skipped: 0 };
  const appliedJobs = [];
  const failedJobs = [];

  // Target roles — skip jobs that are clearly irrelevant
  const TARGET_KEYWORDS = ['data', 'devops', 'cloud', 'full stack', 'fullstack', 'backend', 'frontend', 'ai ', 'machine learning', 'ml ', 'analytics', 'infrastructure', 'platform', 'sre', 'site reliability', 'software engineer', 'developer'];
  const SKIP_KEYWORDS = ['c++ developer', 'embedded', 'firmware', 'hardware', 'mechanical', 'civil', 'chemical', 'electrical engineer', 'nurse', 'doctor', 'sales rep', 'account executive'];

  for (const job of jobs) {
    const page = await context.newPage();
    console.log(`\n━━━ ${job.title} @ ${job.company} ━━━`);

    try {
      // Pre-filter: skip irrelevant roles to save API tokens
      const titleLower = (job.title || '').toLowerCase();
      const isRelevant = TARGET_KEYWORDS.some(kw => titleLower.includes(kw));
      const isExcluded = SKIP_KEYWORDS.some(kw => titleLower.includes(kw));
      if (isExcluded || (!isRelevant && !job.archetype)) {
        console.log(`  ⏭️ Skipping: role "${job.title}" doesn't match target roles`);
        results.skipped++;
        await page.close().catch(() => {});
        await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id);
        continue;
      }

      await page.goto(job.apply_link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Pre-flight: detect dead/404 pages before wasting API tokens
      const pageText = await page.textContent('body').catch(() => '');
      const pageLower = pageText.toLowerCase();
      if (pageLower.includes('page not found') || pageLower.includes('404') || pageLower.includes('this position has been filled') || pageLower.includes('this job is no longer available') || pageLower.includes('no longer accepting applications')) {
        throw new Error('Dead page: job listing removed or expired');
      }

      // Dismiss cookie banners before interacting with the form
      await dismissCookieBanners(page);

      // 1. Generate tailored resume (if possible)
      const tailoredInfo = await generateTailoredResume(job, context, supabase, RESUME_PATH);
      const activeResumePath = tailoredInfo.pdfPath;
      const tailoredChanges = tailoredInfo.changes;

      // 2. Fill base generic fields
      await fillBaseFields(page, activeResumePath);

      // 2.5 Hard-code demographic/survey fields (gender, race, veteran, disability)
      await fillDemographicFields(page);

      // 3. Fill custom dynamic fields via Groq AI
      await fillDynamicFields(page);

      // 4. Multi-step form navigation loop (handles Greenhouse, Ashby, Lever, Workday)
      // Each iteration: fill visible fields → try Submit → else try Next → repeat
      const MAX_STEPS = 10;
      let submitted = false;
      let stepCount = 0;

      const SUBMIT_SELECTORS = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit Application")',
        'button:has-text("Submit application")',
        'button:has-text("Submit")',
        'button.submit-application',
        '#submit_app',
        'button[data-testid="submit-application"]',
      ];
      const NEXT_SELECTORS = [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Weiter")',
        'button:has-text("Next Step")',
        'button:has-text("Next Page")',
        'button[data-testid="next-button"]',
        'button[data-testid="continue"]',
        'a:has-text("Next")',
        'a:has-text("Continue")',
        '.next-btn',
        '#next-button',
      ];
      const FINAL_PAGE_SIGNALS = ['review your application', 'review and submit', 'überprüfen', 'zusammenfassung'];

      while (!submitted && stepCount < MAX_STEPS) {
        stepCount++;
        console.log(`  📄 Form step ${stepCount}/${MAX_STEPS}...`);

        // Re-fill fields on every new step (each step = new DOM)
        await fillBaseFields(page, activeResumePath);
        await fillDemographicFields(page);
        await fillDynamicFields(page);
        await page.waitForTimeout(800);

        // Check if this is a review/summary step
        const stepBodyText = await page.textContent('body').catch(() => '');
        const isReviewStep = FINAL_PAGE_SIGNALS.some(s => stepBodyText.toLowerCase().includes(s));

        // Try Submit first (always highest priority)
        let clickedSomething = false;
        for (const sel of SUBMIT_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            console.log(`  🔘 Step ${stepCount}: Clicking SUBMIT`);
            await btn.click();
            submitted = true;
            clickedSomething = true;
            break;
          }
        }
        if (submitted) break;

        // On a review step, wait once more for Submit to appear
        if (isReviewStep) {
          console.log(`  🔎 Review step detected — waiting 2s for submit button...`);
          await page.waitForTimeout(2000);
          for (const sel of SUBMIT_SELECTORS) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
              console.log(`  🔘 Clicking SUBMIT on review step`);
              await btn.click();
              submitted = true;
              clickedSomething = true;
              break;
            }
          }
          if (submitted) break;
        }

        // Try Next/Continue to advance to the next step
        for (const sel of NEXT_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            const btnText = await btn.textContent().catch(() => sel);
            console.log(`  ➡️  Step ${stepCount}: Clicking NEXT → "${btnText.trim()}"`);
            await btn.click();
            clickedSomething = true;
            await page.waitForTimeout(2500);
            break;
          }
        }

        if (!clickedSomething) {
          throw new Error(`No Submit or Next button found on step ${stepCount}`);
        }
      }

      if (!submitted) throw new Error(`Form exceeded ${MAX_STEPS} steps without Submit button`);


      // 4. Strict Verification — require EXPLICIT confirmation, never assume success
      await page.waitForTimeout(10000);
      const url = page.url().toLowerCase();
      const postSubmitPageText = await page.textContent('body').catch(() => '');
      const postSubmitLower = postSubmitPageText.toLowerCase();
      
      // --- Bot/Captcha detection ---
      if (postSubmitLower.includes('please solve this captcha') || postSubmitLower.includes('verify you are human') || postSubmitLower.includes('checking if the site connection is secure')) {
         job.hasCaptcha = true;
         throw new Error('Captcha Blocked Submission');
      }

      // --- Spam/bot block detection ---
      if (postSubmitLower.includes('flagged as possible spam') || postSubmitLower.includes('flagged as spam') || postSubmitLower.includes('submission was blocked') || postSubmitLower.includes('robot') || postSubmitLower.includes('automated submission')) {
        throw new Error('Submission blocked as spam/bot by ATS');
      }
      
      // --- SUCCESS requires an EXPLICIT positive signal ---
      const isSuccessUrl = url.includes('/thank') || url.includes('thank_you') || url.includes('/confirmation') || url.includes('/applied') || url.includes('/success');
      const isSuccessText = postSubmitLower.includes('thank you for applying') ||
                            postSubmitLower.includes('application received') ||
                            postSubmitLower.includes('application has been received') ||
                            postSubmitLower.includes('successfully submitted') ||
                            postSubmitLower.includes('your job application has been sent') ||
                            postSubmitLower.includes('we have received your application') ||
                            postSubmitLower.includes('application was submitted') ||
                            postSubmitLower.includes('you have applied');

      // --- ERROR detection (broadened to catch banner-style errors) ---
      const errorSelectors = [
        '.error', '.error-message', '.error-banner', '.alert-danger', '.alert-error',
        '[aria-invalid="true"]', '.invalid', '.parsley-error', '.text-danger',
        '.application-error', '.form-error', '.validation-error', '[role="alert"]'
      ];
      let hasErrors = false;
      for (const sel of errorSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          const errText = await el.textContent().catch(() => '');
          // Ignore generic aria alerts that are not errors
          if (errText && errText.trim().length > 0 && !errText.toLowerCase().includes('success')) {
            console.log(`  ⚠️ Error element detected: "${errText.trim().substring(0, 80)}"`);
            hasErrors = true;
            break;
          }
        }
      }

      // Also check for error-like text in page body
      if (!hasErrors && (postSubmitLower.includes('missing entry for required field') || postSubmitLower.includes('please fill in') || postSubmitLower.includes('this field is required') || postSubmitLower.includes('required field'))) {
        console.log(`  ⚠️ Required field validation error detected in page text`);
        hasErrors = true;
      }
      
      const needsEmailVerification = postSubmitLower.includes('check your email') || 
                                     postSubmitLower.includes('verify your email') || 
                                     postSubmitLower.includes('confirm your email') ||
                                     url.includes('join.com');

      // SUCCESS = explicit positive signal AND no errors. NO LONGER fallback on !submitButtonStillThere
      if (!hasErrors && (isSuccessUrl || isSuccessText)) {
        console.log('  ✅ Application verified successful!');
        results.applied++;
        job.needsEmailVerification = needsEmailVerification;
        
        // 5. Insert Application and Take Screenshot Proof
        let methodCol = 'auto';
        if (tailoredChanges !== 'Base Resume (No modifications)') {
           methodCol = 'auto | ' + tailoredChanges.substring(0, 100);
        }

        const { data: appData } = await supabase.from('applications').insert({
          evaluation_id: job.eval_id, method: methodCol, status: 'submitted', pdf_path: tailoredInfo.publicUrl || RESUME_PATH, applied_at: new Date().toISOString()
        }).select('id').single();

        if (appData) {
          job.app_id = appData.id;
          const screenshotPath = join(ROOT, `proof_${job.eval_id}.jpeg`);
          await page.screenshot({ path: screenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
          const screenshotBuffer = readFileSync(screenshotPath);
          await supabase.storage.from('screenshots').upload(`${appData.id}.jpeg`, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
        }
        job.resumeUsed = basename(activeResumePath || RESUME_PATH);
        await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
        
        // 6. Send Cold Email and track result for Discord
        try {
          const { sendColdEmail } = await import('../services/cold-email.js');
          // Use readable YAML profile instead of raw PDF bytes which breaks Groq!
          const cvText = PROFILE_YAML; 
          const emailSentTo = await sendColdEmail(job, null, cvText, activeResumePath);
          
          if (emailSentTo) {
            job.coldEmailSent = true;
            job.coldEmailTarget = emailSentTo;
          } else {
            job.coldEmailSent = false;
            job.coldEmailError = 'AI generation failed or target blocked';
          }
        } catch (emailErr) {
          console.log(`  ⚠️ Cold email failed: ${emailErr.message}`);
          job.coldEmailSent = false;
          job.coldEmailError = emailErr.message;
        }

        appliedJobs.push(job);
      } else {
        throw new Error('Validation error or missing success confirmation');
      }

    } catch (e) {
      console.log(`  ❌ Failed: ${e.message}`);
      results.failed++;
      job.errorMessage = e.message;
      
      // Take a debug screenshot of the failure
      if (!job.errorScreenshotPath) {
         try {
           const errorScreenshotPath = join(ROOT, `error_${job.eval_id}.jpeg`);
           await page.screenshot({ path: errorScreenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
           job.errorScreenshotPath = errorScreenshotPath;
         } catch (err) {}
      }
      
      failedJobs.push(job);
      // Revert to manual_queue
      await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id);
    }

    await page.close().catch(() => {});
  }

  await browser.close();

  console.log(`\n📊 Results: ${results.applied} applied, ${results.failed} failed, ${results.skipped || 0} skipped\n`);

  for (const aj of appliedJobs) {
    const proofUrl = aj.app_id ? `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${aj.app_id}.jpeg` : undefined;
    const coldEmailStatus = aj.coldEmailSent
      ? `✅ Cold email sent to \`${aj.coldEmailTarget}\``
      : `❌ Cold email not sent${aj.coldEmailError ? ` (${aj.coldEmailError})` : ''}`;
    await sendDiscordEmbed({
      title: `✅ Auto-Applied: ${aj.title}`,
      description: `Successfully applied to **${aj.company}**!${aj.needsEmailVerification ? '\n\n⚠️ **ATTENTION:** This platform requires email verification. Please check your inbox and click the confirmation link to finalize your application!' : ''}`,
      color: 0x00d2a0,
      fields: [
        { name: '⭐ ATS Score', value: `${aj.score ? aj.score.toFixed(1) : '?'} / 5.0`, inline: true },
        { name: '📄 Resume Used', value: aj.resumeUsed || basename(RESUME_PATH), inline: true },
        { name: '📧 Cold Email', value: coldEmailStatus, inline: false }
      ],
      image: proofUrl ? { url: proofUrl } : undefined,
      timestamp: new Date().toISOString()
    });
    // Tiny delay to avoid Discord rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  if (failedJobs.length > 0) {
    for (const fj of failedJobs) {
      let errorProofUrl = null;
      if (fj.errorScreenshotPath && existsSync(fj.errorScreenshotPath)) {
        try {
          const screenshotBuffer = readFileSync(fj.errorScreenshotPath);
          const fileName = `error_${fj.eval_id}.jpeg`;
          await supabase.storage.from('screenshots').upload(fileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
          errorProofUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
        } catch (err) {}
      }

      let failureReason = fj.hasCaptcha ? 'Captcha Blocked' : (fj.errorMessage || 'Validation Error');

      await supabase.from('applications').insert({
        evaluation_id: fj.eval_id,
        method: failureReason.substring(0, 100), // Store reason in method
        status: 'failed',
        pdf_path: errorProofUrl || null, // Store screenshot URL in pdf_path
        applied_at: new Date().toISOString()
      });

      await sendDiscordEmbed({
        title: `⚠️ Auto-Apply Failed: ${fj.title}`,
        description: `Failed to auto-apply to **${fj.company}**. Returned to **Manual Queue**.`,
        color: 0xff4500,
        fields: [
          { name: '❌ Reason', value: failureReason.substring(0, 100), inline: false },
          { name: '👉 Apply Manually', value: `[Click Here](${fj.apply_link})`, inline: false }
        ],
        image: errorProofUrl ? { url: errorProofUrl } : undefined,
        timestamp: new Date().toISOString()
      });
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
