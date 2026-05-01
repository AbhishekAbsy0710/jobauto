#!/usr/bin/env node
/**
 * Playwright Browser Auto-Apply
 * Opens each job's application page and fills out the form automatically
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0'; // Use local project browsers
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

const PROFILE = {
  firstName: 'Abhishek Raj',
  lastName: 'Pagadala',
  fullName: 'Abhishek Raj Pagadala',
  email: process.env.APPLICANT_EMAIL || 'pagadalaabhishek60@gmail.com',
  phone: process.env.APPLICANT_PHONE || '+49 176 6723 9250',
  linkedin: 'https://www.linkedin.com/in/abhishek-raj-pagadala',
  website: '',
  city: 'Munich',
  country: 'Germany',
};

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

async function sendDiscord(title, description, color = 0x00d2a0) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [{ title, description, color, timestamp: new Date().toISOString(), footer: { text: 'Auto-Apply via Playwright' } }] })
    });
  } catch {}
}

// ============================================
// GREENHOUSE FORM FILLER
// ============================================
async function applyGreenhouse(page, job) {
  console.log('  🌿 Greenhouse form detected');

  // Wait for the application form
  await page.waitForSelector('#application_form, form[action*="applications"], #s2_application', { timeout: 10000 }).catch(() => {});

  // Fill name fields
  await fillField(page, '#first_name, input[name="first_name"], input[name*="first_name"]', PROFILE.firstName);
  await fillField(page, '#last_name, input[name="last_name"], input[name*="last_name"]', PROFILE.lastName);
  await fillField(page, '#email, input[name="email"], input[type="email"]', PROFILE.email);
  await fillField(page, '#phone, input[name="phone"], input[type="tel"]', PROFILE.phone);

  // LinkedIn field
  await fillField(page, 'input[name*="linkedin"], input[id*="linkedin"], input[placeholder*="LinkedIn"]', PROFILE.linkedin);

  // Location / City
  await fillField(page, 'input[name*="location"], input[id*="location"], input[placeholder*="City"]', PROFILE.city);

  // Upload resume
  await uploadResume(page);

  // Check any checkboxes (consent, terms)
  const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
  for (const cb of checkboxes) {
    const label = await cb.evaluate(el => el.closest('label')?.textContent || '');
    if (label.toLowerCase().includes('consent') || label.toLowerCase().includes('agree') || label.toLowerCase().includes('privacy') || label.toLowerCase().includes('acknowledge')) {
      await cb.check().catch(() => {});
    }
  }

  // Submit
  await clickSubmit(page);
  return true;
}

// ============================================
// LEVER FORM FILLER
// ============================================
async function applyLever(page, job) {
  console.log('  🔷 Lever form detected');

  // Click "Apply for this job" button first
  const applyBtn = await page.$('a.postings-btn, .posting-btn-submit, a[href*="apply"]');
  if (applyBtn) {
    await applyBtn.click();
    await page.waitForTimeout(2000);
  }

  await fillField(page, 'input[name="name"], input[name="cards[0][field0]"]', PROFILE.fullName);
  await fillField(page, 'input[name="email"], input[name="cards[0][field1]"]', PROFILE.email);
  await fillField(page, 'input[name="phone"], input[name="cards[0][field2]"]', PROFILE.phone);
  await fillField(page, 'input[name*="linkedin"], input[name="urls[LinkedIn]"]', PROFILE.linkedin);
  await fillField(page, 'input[name*="location"], input[name="cards[0][field5]"]', `${PROFILE.city}, ${PROFILE.country}`);

  await uploadResume(page);
  await clickSubmit(page);
  return true;
}

// ============================================
// GENERIC FORM FILLER (ArbeitNow, RemoteOK, etc.)
// ============================================
async function applyGeneric(page, job) {
  console.log('  📝 Generic form fill');

  // Look for Apply button first
  const applyBtns = await page.$$('a:has-text("Apply"), button:has-text("Apply"), a.apply-button, .apply-btn');
  for (const btn of applyBtns) {
    const href = await btn.getAttribute('href').catch(() => '');
    const text = await btn.textContent().catch(() => '');
    if (text.toLowerCase().includes('apply')) {
      console.log('  ➡️ Clicking Apply button...');
      await btn.click().catch(() => {});
      await page.waitForTimeout(3000);
      break;
    }
  }

  // Try filling any visible form
  await fillField(page, 'input[name*="name"]:not([name*="last"]):not([name*="company"]), input[id*="name"]:not([id*="last"])', PROFILE.fullName);
  await fillField(page, 'input[name*="first"], input[id*="first"]', PROFILE.firstName);
  await fillField(page, 'input[name*="last_name"], input[id*="last"]', PROFILE.lastName);
  await fillField(page, 'input[type="email"], input[name*="email"]', PROFILE.email);
  await fillField(page, 'input[type="tel"], input[name*="phone"]', PROFILE.phone);
  await fillField(page, 'input[name*="linkedin"], input[placeholder*="LinkedIn"]', PROFILE.linkedin);

  await uploadResume(page);
  await clickSubmit(page);
  return true;
}

// ============================================
// HELPERS
// ============================================
async function fillField(page, selector, value) {
  try {
    const field = await page.$(selector);
    if (field) {
      const visible = await field.isVisible();
      if (visible) {
        await field.click();
        await field.fill(value);
        return true;
      }
    }
  } catch {}
  return false;
}

async function uploadResume(page) {
  if (!existsSync(RESUME_PATH)) {
    console.log('  ⚠️ No resume PDF found');
    return false;
  }
  try {
    // Find file input
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      const accept = await input.getAttribute('accept') || '';
      const name = await input.getAttribute('name') || '';
      const id = await input.getAttribute('id') || '';
      // Prefer resume-related file inputs
      if (accept.includes('pdf') || name.includes('resume') || name.includes('cv') || id.includes('resume') || id.includes('cv') || fileInputs.length === 1) {
        await input.setInputFiles(RESUME_PATH);
        console.log('  📎 Resume uploaded');
        return true;
      }
    }
    // If only one file input, use it
    if (fileInputs.length >= 1) {
      await fileInputs[0].setInputFiles(RESUME_PATH);
      console.log('  📎 Resume uploaded (first input)');
      return true;
    }
  } catch (e) {
    console.log(`  ⚠️ Resume upload failed: ${e.message}`);
  }
  return false;
}

async function clickSubmit(page) {
  // Look for submit button
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button:has-text("Send")',
    'button:has-text("Bewerben")',
    'button.submit-application',
    '#submit_app',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        console.log('  🔘 Clicking submit...');
        await btn.click();
        await page.waitForTimeout(3000);
        return true;
      }
    } catch {}
  }
  console.log('  ⚠️ No submit button found');
  return false;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Get jobs joined with evaluations
  const { data: rawJobs, error } = await supabase
    .from('jobs')
    .select('*, evaluations!inner(id, letter_grade, weighted_score, matching_skills)')
    .in('status', ['auto_queue', 'manual_queue']);

  if (error) {
    console.error('Error fetching jobs:', error.message);
    process.exit(1);
  }

  // Filter and map to flat structure like the old SQL query
  let jobs = (rawJobs || [])
    .filter(j => {
      const grade = Array.isArray(j.evaluations) ? j.evaluations[0]?.letter_grade : j.evaluations?.letter_grade;
      return grade === 'A' || grade === 'B';
    })
    .map(j => {
      const e = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
      return {
        ...j,
        eval_id: e.id,
        letter_grade: e.letter_grade,
        weighted_score: e.weighted_score,
        matching_skills: e.matching_skills
      };
    })
    .sort((a, b) => b.weighted_score - a.weighted_score);

  if (jobs.length === 0) {
    console.log('📭 No jobs in the apply queue');
    return;
  }

  console.log(`\n🚀 Auto-applying to ${jobs.length} jobs via Playwright...\n`);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 150,
    timeout: 30000,
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const results = { applied: 0, failed: 0, skipped: 0 };
  const appliedJobs = [];

  for (const job of jobs) {
    const page = await context.newPage();
    console.log(`\n━━━ ${job.title} @ ${job.company} (${job.platform}) ━━━`);
    console.log(`    📍 ${job.location} | Score: ${job.weighted_score}/5`);
    console.log(`    🔗 ${job.apply_link}`);

    try {
      await page.goto(job.apply_link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      let success = false;

      // Detect platform and use appropriate form filler
      const url = page.url();
      if (url.includes('greenhouse') || url.includes('boards.greenhouse')) {
        success = await applyGreenhouse(page, job);
      } else if (url.includes('lever.co') || url.includes('jobs.lever')) {
        success = await applyLever(page, job);
      } else {
        success = await applyGeneric(page, job);
      }

      // Check for success indicators
      await page.waitForTimeout(2000);
      const pageText = await page.textContent('body').catch(() => '');
      const isSuccess = pageText.toLowerCase().includes('thank') ||
                        pageText.toLowerCase().includes('submitted') ||
                        pageText.toLowerCase().includes('received') ||
                        pageText.toLowerCase().includes('applied');

      if (isSuccess || success) {
        console.log('  ✅ Application submitted!');
        results.applied++;
        appliedJobs.push(job);

        // Record in DB
        await supabase.from('applications').insert({
          evaluation_id: job.eval_id,
          method: 'auto',
          status: 'submitted',
          pdf_path: RESUME_PATH,
          applied_at: new Date().toISOString()
        });
        await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
      } else {
        console.log('  ⚠️ May need manual review — form filled but submit uncertain');
        results.skipped++;
      }

    } catch (e) {
      console.log(`  ❌ Failed: ${e.message}`);
      results.failed++;
    }

    await page.close().catch(() => {});
    await new Promise(r => setTimeout(r, 2000)); // Be polite between applications
  }

  await browser.close();

  // Summary
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`📊 Auto-Apply Results:`);
  console.log(`   ✅ Applied:  ${results.applied}`);
  console.log(`   ⚠️ Skipped:  ${results.skipped}`);
  console.log(`   ❌ Failed:   ${results.failed}`);
  console.log(`${'━'.repeat(50)}\n`);

  // Send Discord summary
  if (appliedJobs.length > 0) {
    const jobList = appliedJobs.map((j, i) =>
      `**${i + 1}. ${j.title}**\n${j.company} · 📍 ${j.location} · Score: ${j.weighted_score}/5\n[View](${j.apply_link})`
    ).join('\n\n');

    await sendDiscord(
      `✅ Auto-Applied to ${appliedJobs.length} Jobs`,
      `${jobList}\n\n📎 Resume: Abhishek_Raj_Pagadala_Resume.pdf\n📊 ${results.applied} applied · ${results.skipped} review · ${results.failed} failed`,
      0x00d2a0
    );
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
