#!/usr/bin/env node
/**
 * Playwright Browser Auto-Apply (AI Powered)
 * Dynamically fills out forms using Groq API
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
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

async function sendDiscord(title, description, color = 0x00d2a0) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [{ title, description, color, timestamp: new Date().toISOString() }] })
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
        if (parent) labelText = parent.innerText.split('\n')[0];
      }

      let options = [];
      if (el.tagName === 'SELECT') {
        options = Array.from(el.querySelectorAll('option')).map(o => o.value || o.innerText.trim()).filter(Boolean);
      } else if (el.type === 'radio' || el.type === 'checkbox') {
        options = [el.value];
        const next = el.nextElementSibling;
        if (next && next.tagName === 'LABEL') labelText += ' - ' + next.innerText;
      }

      return {
        id: el.id || '',
        name: el.name || '',
        type: el.type || el.tagName.toLowerCase(),
        label: labelText.substring(0, 150).replace(/\s+/g, ' ').trim(),
        options: options.slice(0, 10)
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

Return JSON strictly in this format:
{"answers": [{"name": "input_name_attribute", "value": "your_answer", "type": "text|select|radio|checkbox"}]}

Rules:
- For 'select' or 'radio', the 'value' MUST exactly match one of the provided options.
- If asking about Visa/Sponsorship, answer "No" (does not require sponsorship) if EU/German context, otherwise "Yes" if outside.
- If asking about Disability/Veteran, answer "Decline to answer" or "No".
- If asking about salary, put "85000" or similar based on profile.`;

  const userPrompt = `Form Fields:\n` + JSON.stringify(questions, null, 2);

  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const data = JSON.parse(res);
    if (!data.answers) return;

    for (const ans of data.answers) {
      try {
        const selector = \`[name="\${ans.name}"]\`;
        if (ans.type === 'radio' || ans.type === 'checkbox') {
          // Find the exact radio/checkbox by value
          const specificSelector = \`\${selector}[value="\${ans.value}"]\`;
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
        console.log(\`    ↳ Filled \${ans.name} -> \${ans.value}\`);
      } catch (e) {}
    }
  } catch (e) {
    console.log(\`  ⚠️ AI fill error: \${e.message}\`);
  }
}

// ============================================
// BASE FORM FILLER
// ============================================
async function fillBaseFields(page) {
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
  if (existsSync(RESUME_PATH)) {
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const accept = await input.getAttribute('accept') || '';
        const name = await input.getAttribute('name') || '';
        if (accept.includes('pdf') || name.includes('resume') || name.includes('cv') || fileInputs.length === 1) {
          await input.setInputFiles(RESUME_PATH);
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

  console.log(\`\\n🚀 Auto-applying to \${jobs.length} jobs via Playwright (AI Enabled)...\\n\`);

  const browser = await chromium.launch({ headless: true, slowMo: 100, timeout: 30000 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const results = { applied: 0, failed: 0 };
  const appliedJobs = [];
  const failedJobs = [];

  for (const job of jobs) {
    const page = await context.newPage();
    console.log(\`\\n━━━ \${job.title} @ \${job.company} ━━━\`);

    try {
      await page.goto(job.apply_link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // 1. Fill base generic fields
      await fillBaseFields(page);

      // 2. Fill custom dynamic fields via Groq AI
      await fillDynamicFields(page);

      // 3. Submit
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
      await page.waitForTimeout(4000);
      const pageText = await page.textContent('body').catch(() => '');
      const isSuccess = pageText.toLowerCase().includes('thank') ||
                        pageText.toLowerCase().includes('submitted') ||
                        pageText.toLowerCase().includes('received') ||
                        pageText.toLowerCase().includes('applied') ||
                        pageText.toLowerCase().includes('success');
      
      const hasErrors = await page.$('.error, .error-message, [aria-invalid="true"], .invalid, .parsley-error').catch(() => null);

      if (isSuccess && !hasErrors) {
        console.log('  ✅ Application verified successful!');
        results.applied++;
        appliedJobs.push(job);
        
        await supabase.from('applications').insert({
          evaluation_id: job.eval_id, method: 'auto', status: 'submitted', pdf_path: RESUME_PATH, applied_at: new Date().toISOString()
        });
        await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
      } else {
        throw new Error('Validation error or missing success confirmation');
      }

    } catch (e) {
      console.log(\`  ❌ Failed: \${e.message}\`);
      results.failed++;
      failedJobs.push(job);
      // Revert to manual_queue
      await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id);
    }

    await page.close().catch(() => {});
  }

  await browser.close();

  console.log(\`\\n📊 Results: \${results.applied} applied, \${results.failed} failed/reverted\\n\`);

  if (appliedJobs.length > 0) {
    const list = appliedJobs.map(j => \`**\${j.title}** at \${j.company}\`).join('\\n');
    await sendDiscord(\`✅ Auto-Applied to \${appliedJobs.length} Jobs\`, list, 0x00d2a0);
  }
  if (failedJobs.length > 0) {
    const list = failedJobs.map(j => \`**\${j.title}** at \${j.company}\`).join('\\n');
    await sendDiscord(\`⚠️ \${failedJobs.length} Jobs Failed Auto-Apply\`, \`These encountered form validation errors and have been moved back to the **Manual Queue**.\\n\\n\${list}\`, 0xff4500);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
