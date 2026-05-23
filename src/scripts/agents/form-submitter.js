/**
 * agents/form-submitter.js — Submit & Navigation Agent
 * 
 * Handles multi-step form loop: Submit/Next detection, button clicking,
 * security code handling, and per-step OneTrust safety.
 * 
 * Exports:
 *   - submitForm(page, opts) — multi-step submit loop
 *   - SUBMIT_SELECTORS — submit button selectors
 *   - NEXT_SELECTORS — next/continue button selectors
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { ensureNoOverlay } from './consent-handler.js';

// ── Submit button selectors (priority order) ──────────────────────────────────
export const SUBMIT_SELECTORS = [
  // Generic
  'button[type="submit"]',
  'input[type="submit"]',
  // SmartRecruiters
  'button[data-qa="btn-apply"]',
  'button[data-qa="action-button"]',
  'button[class*="wds-button"][class*="primary"]',
  'button:has-text("Submit Application")',
  'button:has-text("Submit application")',
  'button:has-text("Send application")',
  // Ashby
  'button[data-testid="ashby-btn-primary"]',
  '.ashby-application-form-submit-button',
  // Greenhouse
  '#submit_app', '#submit-app',
  'button#submit_app',
  'input#submit_app',
  // Lever
  'button.postings-btn.template-btn-submit',
  'a.postings-btn',
  // Generic text
  'button:has-text("Submit")',
  'button:has-text("Apply")',
  'button:has-text("Apply Now")',
  'button:has-text("Send Application")',
  'button:has-text("Send your application")',
  'button:has-text("Bewerbung absenden")',
  'button:has-text("Jetzt bewerben")',
  // Workday
  'button[data-automation-id="bottom-navigation-next-button"]',
  'button[data-automation-id="bottom-navigation-review-btn"]',
  // Teamtailor
  'button[data-testid="submit-button"]',
  'button.button--primary:has-text("Send application")',
  'button.button--primary:has-text("Apply")',
  // Misc
  'button.submit-application',
  '[data-action="submit"]',
  'button[aria-label*="submit" i]',
  'button[aria-label*="apply" i]',
];

// ── Next/Continue button selectors ────────────────────────────────────────────
export const NEXT_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Weiter")',
  'button:has-text("Next Step")',
  'button:has-text("Next Page")',
  'button:has-text("Review")',
  // SmartRecruiters specific
  'button[data-qa="action-button"]',
  'button[class*="wds-button"]',
  'button:has-text("Start Application")',
  'button:has-text("Start application")',
  'button:has-text("I understand")',
  '[data-qa="btn-continue"]',
  // Workday / generic
  'button[data-testid="next-button"]',
  'button[data-testid="continue"]',
  'button[data-automation-id="bottom-navigation-next-button"]',
  'a:has-text("Next")',
  'a:has-text("Continue")',
  '.next-btn', '#next-button',
  'button[aria-label*="next" i]',
];

const FINAL_PAGE_SIGNALS = ['review your application', 'review and submit', 'überprüfen', 'zusammenfassung'];

/**
 * Multi-step form submission loop.
 * 
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {Function} opts.fillStep - Function to fill fields on each step: fillStep(page)
 * @param {object} opts.job - Job object (for security code handling)
 * @param {object} opts.supabase - Supabase client (for security code status updates)
 * @param {number} opts.maxSteps - Max steps before giving up (default: 10)
 * @returns {{ submitted: boolean, stepCount: number }}
 */
export async function submitForm(page, opts = {}) {
  const { fillStep, job = {}, supabase = null, maxSteps = 10 } = opts;
  let submitted = false;
  let stepCount = 0;

  while (!submitted && stepCount < maxSteps) {
    stepCount++;
    console.log(`  📄 Form step ${stepCount}/${maxSteps}...`);

    // Safety: dismiss any lingering OneTrust overlay
    await ensureNoOverlay(page, stepCount);

    // Fill fields on this step (caller provides the fill function)
    if (fillStep) {
      await fillStep(page);
    }
    await page.waitForTimeout(800);

    // Check if this is a review/summary step
    const stepBodyText = await page.textContent('body').catch(() => '');
    const isReviewStep = FINAL_PAGE_SIGNALS.some(s => stepBodyText.toLowerCase().includes(s));

    // Try Submit first (highest priority)
    let clickedSomething = false;
    for (const sel of SUBMIT_SELECTORS) {
      const btn = await page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await page.screenshot({ path: 'debug_pre_submit.png', fullPage: true });
        console.log(`  🔘 Step ${stepCount}: Clicking SUBMIT`);
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 10000 }).catch(async () => {
          await btn.click({ force: true, timeout: 10000 }).catch(() => {});
        });
        submitted = true;
        clickedSomething = true;

        // Wait for UI to update
        await page.waitForTimeout(2000);

        // Handle Greenhouse Security Code Verification
        await handleSecurityCode(page, btn, job, supabase);

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

    // Try Next/Continue to advance
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

  if (!submitted) throw new Error(`Form exceeded ${maxSteps} steps without Submit button`);

  return { submitted, stepCount };
}

// ── Security Code Handler ──────────────────────────────────────────────────────
async function handleSecurityCode(page, submitBtn, job, supabase) {
  const securityInput = await page.$('#security-input-0').catch(() => null);
  if (!securityInput || !await securityInput.isVisible().catch(() => false)) return;

  const companyName = job.company || 'Company';
  const safeCompany = companyName.replace(/['"\\]/g, '');
  console.log(`  🔒 Security code verification required!`);
  writeFileSync('WAITING_FOR_SECURITY_CODE.txt', `Check email for code from ${companyName}`);

  // Notification
  try {
    const { execSync } = await import('child_process');
    execSync(`osascript -e 'display notification "Check email: code needed for ${safeCompany}" with title "JobAuto: OTP Required" sound name "Glass"'`);
  } catch {}
  process.stdout.write('\x07'); // terminal bell
  console.log(`  ⏳ Gmail OTP watcher active — waiting up to 10 min for code from ${companyName}...`);

  let code = '';
  const deadline = Date.now() + 10 * 60 * 1000;
  while (true) {
    if (Date.now() > deadline) {
      console.log('  ⏰ Security code timeout (10 min)');
      try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch {}
      if (supabase) {
        await supabase.from('jobs').update({ status: 'security_required', notes: 'Email verification required' }).eq('id', job.id).catch(() => {});
      }
      throw new Error('Security code required — timed out');
    }
    if (existsSync('security_code.txt')) {
      code = readFileSync('security_code.txt', 'utf8').trim();
      unlinkSync('security_code.txt');
      if (code.length >= 6) {
        console.log(`  ✅ Code received!`);
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  console.log(`  ✅ Filling security code...`);
  for (let i = 0; i < code.length && i < 8; i++) {
    const input = await page.$(`#security-input-${i}`).catch(() => null);
    if (input) await input.type(code[i], { delay: 50 });
  }

  try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch {}
  try { unlinkSync('security_code.txt'); } catch {}

  await page.waitForTimeout(1000);
  console.log(`  🔘 Clicking SUBMIT again after security code`);
  await submitBtn.click();
  await page.waitForTimeout(1500);
}
