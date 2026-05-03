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
  envFile.split('\\n').forEach(line => {
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

async function callGroq(systemPrompt, userPrompt) {
  if (!process.env.GROQ_API_KEY) return '{}';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) return '{}';
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
      const name = (el.name || '').toLowerCase();
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
        name: el.name || '',
        type: el.type || el.tagName.toLowerCase(),
        label: labelText.substring(0, 150).replace(/\s+/g, ' ').trim(),
        options: options.slice(0, 20)
      };
    }).filter(f => f && f.label && f.name); // must have name to target
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
- If the question asks for a link (LinkedIn/GitHub/Portfolio), you MUST use exactly the URL provided above. ALWAYS include https:// otherwise the form will fail validation.`;

  const userPrompt = `Form Fields:\n` + JSON.stringify(questions, null, 2);

  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const data = JSON.parse(res);
    if (!data.answers) return;

    for (const ans of data.answers) {
      try {
        const selector = `[name="${ans.name}"]`;
        if (ans.type === 'radio' || ans.type === 'checkbox') {
          // Find the exact radio/checkbox by value
          const specificSelector = `${selector}[value="${ans.value}"]`;
          await page.click(specificSelector, { timeout: 1000 }).catch(async () => {
             // Fallback if value isn't exact
             const els = await page.$$(selector);
             if (els.length > 0) await els[0].check().catch(()=>{});
          });
        } else if (ans.type === 'select' || ans.type === 'select-one') {
          await page.selectOption(selector, { value: ans.value }).catch(() => page.selectOption(selector, { label: ans.value }));
        } else {
          await page.fill(selector, ans.value);
        }
        console.log(`    ↳ Filled ${ans.name} -> ${ans.value}`);
      } catch (e) {}
    }
  } catch (e) {
    console.log(`  ⚠️ AI fill error: ${e.message}`);
  }
}

// ============================================
// BASE FORM FILLER
// ============================================
async function fillBaseFields(page, resumePath) {
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

  const sysPrompt = `You are an expert technical recruiter and resume writer.
Rewrite the candidate's base resume strictly in JSON format to align perfectly with the target Job Description.
RULES:
1. Do NOT hallucinate new experiences, companies, degrees, or tools the candidate has not used.
2. Reword the 'summary' and the 'bullets' inside 'experience' to emphasize skills required by the job. Remove irrelevant bullets if necessary to keep it concise.
3. Include a 'changes_made' string field summarizing the modifications in 1 sentence.
Return ONLY valid JSON matching the structure of the provided base resume (adding 'changes_made').`;

  const userPrompt = `Job Title: ${job.title}\nJob Company: ${job.company}\nJob Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nBase Resume JSON:\n${baseJsonStr}`;

  let tailoredJson;
  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    tailoredJson = JSON.parse(match[0]);
  } catch(e) {
    console.log('  ⚠️ Failed to generate tailored resume JSON, using base.');
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

  console.log(`\\\n🚀 Auto-applying to ${jobs.length} jobs via Playwright (AI Enabled)...\\\n`);

  const browser = await chromium.launch({ headless: true, slowMo: 100, timeout: 30000 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  
  // Set a strict global timeout so the bot fails fast instead of hanging for 30s per bad field
  context.setDefaultTimeout(3000);

  const results = { applied: 0, failed: 0 };
  const appliedJobs = [];
  const failedJobs = [];

  for (const job of jobs) {
    const page = await context.newPage();
    console.log(`\\\n━━━ ${job.title} @ ${job.company} ━━━`);

    try {
      await page.goto(job.apply_link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // 1. Generate tailored resume (if possible)
      const tailoredInfo = await generateTailoredResume(job, context, supabase, RESUME_PATH);
      const activeResumePath = tailoredInfo.pdfPath;
      const tailoredChanges = tailoredInfo.changes;

      // 2. Fill base generic fields
      await fillBaseFields(page, activeResumePath);

      // 3. Fill custom dynamic fields via Groq AI
      await fillDynamicFields(page);

      // 4. Submit
      let submitted = false;
      const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Apply")', 'button.submit-application', '#submit_app'];
      for (const sel of submitSelectors) {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          console.log('  🔘 Clicking submit...');
          await btn.click();
          submitted = true;
          break;
        }
      }

      if (!submitted) throw new Error('No submit button found');

      // 4. Strict Verification
      await page.waitForTimeout(10000);
      const url = page.url().toLowerCase();
      const pageText = await page.textContent('body').catch(() => '');
      
      if (pageText.toLowerCase().includes('please solve this captcha') || pageText.toLowerCase().includes('verify you are human') || pageText.toLowerCase().includes('checking if the site connection is secure')) {
         job.hasCaptcha = true;
         throw new Error('Captcha Blocked Submission');
      }
      
      const isSuccessUrl = url.includes('thank') || url.includes('confirm') || url.includes('success');
      const isSuccessText = pageText.toLowerCase().includes('thank you for applying') ||
                            pageText.toLowerCase().includes('application received') ||
                            pageText.toLowerCase().includes('application has been received') ||
                            pageText.toLowerCase().includes('successfully submitted');

      const hasErrors = await page.$('.error, .error-message, [aria-invalid="true"], .invalid, .parsley-error, .text-danger, .application-error').catch(() => null);

      let submitButtonStillThere = false;
      for (const sel of submitSelectors) {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) submitButtonStillThere = true;
      }
      
      const needsEmailVerification = pageText.toLowerCase().includes('check your email') || 
                                     pageText.toLowerCase().includes('verify your email') || 
                                     pageText.toLowerCase().includes('confirm your email') ||
                                     url.includes('join.com');

      // It is successful IF there are no visible errors AND (we hit a success URL OR we see a success message OR the submit button disappeared)
      if (!hasErrors && (isSuccessUrl || isSuccessText || !submitButtonStillThere)) {
        console.log('  ✅ Application verified successful!');
        results.applied++;
        job.needsEmailVerification = needsEmailVerification;
        appliedJobs.push(job);
        
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
        appliedJobs.push(job);
        await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
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

  console.log(`\n📊 Results: ${results.applied} applied, ${results.failed} failed/reverted\n`);

  for (const aj of appliedJobs) {
    const proofUrl = aj.app_id ? `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${aj.app_id}.jpeg` : undefined;
    await sendDiscordEmbed({
      title: `✅ Auto-Applied: ${aj.title}`,
      description: `Successfully applied to **${aj.company}**!${aj.needsEmailVerification ? '\n\n⚠️ **ATTENTION:** This platform requires email verification. Please check your inbox and click the confirmation link to finalize your application!' : ''}`,
      color: 0x00d2a0,
      fields: [
        { name: '⭐ ATS Score', value: `${aj.score ? aj.score.toFixed(1) : '?'} / 5.0`, inline: true },
        { name: '📄 Resume Used', value: basename(RESUME_PATH), inline: true }
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
        description: `Failed to auto-apply to **${fj.company}**. It has been safely returned to your **Manual Queue**.\\n\\n**Reason:** ${failureReason}\\nCheck the screenshot below to see exactly what the bot saw!\\n\\n[👉 Click Here to Apply Manually](${fj.apply_link})`,
        color: 0xff4500,
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
