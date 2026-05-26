/**
 * agents/form-submitter.js — Submit & Navigation Agent
 * 
 * Handles multi-step form loop: Submit/Next detection, button clicking,
 * consent checkbox auto-check, security code handling, button diagnostics,
 * disabled button fallback, and per-step OneTrust safety.
 * 
 * Exports:
 *   - submitForm(page, opts) — multi-step submit loop
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { ensureNoOverlay } from './consent-handler.js';
import { SUBMIT_SELECTORS, NEXT_SELECTORS, FINAL_PAGE_SIGNALS, MAX_STEPS } from './constants.js';

/**
 * Multi-step form submission loop.
 * Each iteration: fill visible fields → check consent → try Submit → else try Next → repeat
 * 
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {Function} opts.fillStep - Function to fill fields on each step: fillStep(page)
 * @param {object} opts.job - Job object (for security code handling)
 * @param {object} opts.supabase - Supabase client (for security code status updates)
 * @param {number} opts.maxSteps - Max steps before giving up (default: MAX_STEPS)
 * @returns {{ submitted: boolean, stepCount: number }}
 */
export async function submitForm(page, opts = {}) {
  const { fillStep, job = {}, supabase = null, maxSteps = MAX_STEPS } = opts;
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

    // ── SR/Generic consent checkboxes: check ALL visible unchecked checkboxes ──
    // SmartRecruiters has its own data consent checkboxes (separate from OneTrust)
    // that must be checked before the Continue/action-button becomes enabled
    const uncheckedBoxes = await page.$$('input[type="checkbox"]:not(:checked)').catch(() => []);
    for (const cb of uncheckedBoxes) {
      try {
        if (!await cb.isVisible().catch(() => false)) continue;
        // Skip OneTrust checkboxes
        const cbId = await cb.getAttribute('id') || '';
        const cbName = await cb.getAttribute('name') || '';
        if (cbId.includes('onetrust') || cbName.includes('onetrust') || cbId.includes('ot-group-id')) continue;
        // Check consent/privacy/terms checkboxes
        const parentText = await cb.evaluate(el => {
          const parent = el.closest('label, div, span');
          return parent ? (parent.innerText || '').substring(0, 200) : '';
        }).catch(() => '');
        const parentLower = parentText.toLowerCase();
        const isConsent = parentLower.includes('consent') || parentLower.includes('agree') || 
                         parentLower.includes('privacy') || parentLower.includes('terms') ||
                         parentLower.includes('data') || parentLower.includes('accept') ||
                         parentLower.includes('acknowledge') || parentLower.includes('confirm') ||
                         parentLower.includes('datenschutz') || parentLower.includes('einwillig');
        if (isConsent || uncheckedBoxes.length <= 3) {
          // For consent steps with few checkboxes, check them all
          await cb.scrollIntoViewIfNeeded().catch(() => {});
          await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
          console.log(`    ☑️ Checked consent: "${parentText.substring(0, 60)}"`);
          await page.waitForTimeout(300);
        }
      } catch {}
    }
    await page.waitForTimeout(500);

    // Check if this is a review/summary step
    const stepBodyText = await page.textContent('body').catch(() => '');
    const isReviewStep = FINAL_PAGE_SIGNALS.some(s => stepBodyText.toLowerCase().includes(s));

    // ── DEEP SANITIZATION & CLICK (Single Frame Bypass) ──
    const shadowClicked = await page.evaluate(() => {
      const nextKeywords = ['next', 'continue', 'submit', 'apply', 'send'];
      const skipKeywords = ['cookie', 'settings', 'privacy', 'onetrust', 'reload', 'cancel', 'back', 'previous'];
      const hostSelectors = ['button[data-qa="action-button"]', 'spl-button', 'sr-button', 'button[type="submit"]', 'button[class*="primary"]'];
      
      for (const sel of hostSelectors) {
        const hosts = document.querySelectorAll(sel);
        for (const host of hosts) {
          if (host.offsetParent === null && !host.closest('[style*="display: none"]')) continue; // Skip invisible
          const hostText = (host.textContent || '').trim().toLowerCase();
          if (skipKeywords.some(sk => hostText.includes(sk))) continue;
          
          if (nextKeywords.some(kw => hostText.includes(kw)) || sel === 'button[data-qa="action-button"]') {
            // DEEP SANITIZATION STEP
            const customTags = 'spl-checkbox, sr-checkbox, spl-radio-group, sr-radio-group, spl-multiselect-autocomplete, sr-multiselect-autocomplete, spl-form-element, sr-form-element';
            document.querySelectorAll(customTags).forEach(el => {
              el.removeAttribute('required'); el.removeAttribute('aria-required'); el.required = false;
              if (el.shadowRoot) {
                el.shadowRoot.querySelectorAll('[required], [aria-required]').forEach(inner => {
                  inner.removeAttribute('required'); inner.removeAttribute('aria-required'); inner.required = false;
                });
              }
            });

            document.querySelectorAll('spl-checkbox, sr-checkbox').forEach(splCb => {
              if (splCb.shadowRoot) {
                const inp = splCb.shadowRoot.querySelector('input[type="checkbox"]');
                if (inp && !inp.checked) {
                  inp.checked = true; inp.removeAttribute('aria-invalid');
                  inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                  splCb.checked = true; splCb.value = true;
                }
              }
            });
            
            const invalidGroups = 'spl-radio-group, sr-radio-group, spl-multiselect-autocomplete, spl-form-element, sr-form-element';
            document.querySelectorAll(invalidGroups).forEach(rg => {
              rg.removeAttribute('aria-invalid');
              if (rg.classList) rg.classList.remove('invalid', 'error', 'has-error');
              if (rg.shadowRoot) {
                 rg.shadowRoot.querySelectorAll('.error-message, [role="alert"]').forEach(e => e.remove());
                 const innerTags = 'input[type="text"], input[type="radio"], input[type="checkbox"], spl-radio, sr-radio';
                 rg.shadowRoot.querySelectorAll(innerTags).forEach(innerInp => {
                   innerInp.removeAttribute('required'); innerInp.removeAttribute('aria-required'); innerInp.required = false;
                   if (innerInp.shadowRoot) {
                      innerInp.shadowRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(ii => {
                        ii.removeAttribute('required'); ii.removeAttribute('aria-required'); ii.required = false;
                      });
                   }
                 });
              }
            });

            const form = host.closest('form');
            if (form) form.setAttribute('novalidate', '');
            
            if (host.disabled) {
              host.disabled = false; host.removeAttribute('disabled'); host.removeAttribute('aria-disabled');
            }

            if (host.shadowRoot) {
              const innerBtn = host.shadowRoot.querySelector('button');
              if (innerBtn) {
                innerBtn.formNoValidate = true; innerBtn.setAttribute('formnovalidate', '');
                const innerForm = innerBtn.closest('form');
                if (innerForm) innerForm.setAttribute('novalidate', '');
                innerBtn.click();
                return hostText;
              }
            }
            
            host.click();
            return hostText;
          }
        }
      }
      return null;
    }).catch(() => null);

    let clickedSomething = false;

    if (shadowClicked) {
      console.log(`  🔘 Step ${stepCount}: Shadow DOM Deep-Sanitized & Clicked → "${shadowClicked}"`);
      clickedSomething = true;
      if (shadowClicked.includes('submit') || shadowClicked.includes('apply') || shadowClicked.includes('send')) {
        submitted = true;
        await page.waitForTimeout(2000);
        // We still need a reference for handleSecurityCode if we can find it
        const submitBtn = await page.$('button[data-qa="action-button"], button[type="submit"]').catch(()=>null);
        await handleSecurityCode(page, submitBtn || page, job, supabase);
      } else {
        await page.waitForTimeout(2500);
      }
    } else {
      // Fallback: standard Playwright selectors if Shadow DOM script found nothing
      for (const sel of SUBMIT_SELECTORS) {
        const btn = await page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await page.screenshot({ path: 'debug_pre_submit.png', fullPage: true }).catch(() => {});
          console.log(`  🔘 Step ${stepCount}: Clicking SUBMIT (Fallback)`);
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click({ timeout: 10000 }).catch(async () => { await btn.click({ force: true, timeout: 10000 }).catch(() => {}); });
          submitted = true;
          clickedSomething = true;
          await page.waitForTimeout(2000);
          await handleSecurityCode(page, btn, job, supabase);
          break;
        }
      }
      
      if (!submitted && isReviewStep) {
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
      }

      if (!submitted) {
        for (const sel of NEXT_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            const btnText = await btn.textContent().catch(() => sel);
            console.log(`  ➡️  Step ${stepCount}: Clicking NEXT → "${btnText.trim()}" (Fallback)`);
            await btn.click();
            clickedSomething = true;
            await page.waitForTimeout(2500);
            break;
          }
        }
      }
    }

    if (!clickedSomething) {
      // Debug: log all visible buttons on the page to understand what's there
      const visibleButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'))
          .filter(b => b.offsetParent !== null && b.offsetWidth > 0)
          .map(b => ({
            tag: b.tagName,
            text: (b.innerText || b.value || '').trim().substring(0, 60),
            qa: b.getAttribute('data-qa') || '',
            type: b.type || '',
            disabled: b.disabled,
            cls: (b.className || '').substring(0, 80)
          }));
      }).catch(() => []);
      console.log(`  🔍 Debug: ${visibleButtons.length} visible buttons found:`);
      for (const b of visibleButtons.slice(0, 10)) {
        console.log(`    → [${b.tag}] "${b.text}" qa="${b.qa}" type="${b.type}" disabled=${b.disabled} cls="${b.cls}"`);
      }

      // Fallback: try clicking disabled action-button after forcing enable
      const disabledBtn = await page.$('button[data-qa="action-button"][disabled], button[data-qa="action-button"][aria-disabled="true"]').catch(() => null);
      if (disabledBtn) {
        console.log(`  ⚡ Found disabled SR action-button — force-enabling and clicking`);
        await page.evaluate(() => {
          const btn = document.querySelector('button[data-qa="action-button"]');
          if (btn) {
            btn.disabled = false;
            btn.removeAttribute('disabled');
            btn.removeAttribute('aria-disabled');
            btn.click();
          }
        });
        await page.waitForTimeout(2000);
        clickedSomething = true;
      }
      
      if (!clickedSomething) {
        // Last resort: try any visible primary/action button
        const anyPrimary = await page.$('button[class*="primary"]:not([disabled]), button[class*="action"]:not([disabled])').catch(() => null);
        if (anyPrimary && await anyPrimary.isVisible().catch(() => false)) {
          const txt = await anyPrimary.textContent().catch(() => 'unknown');
          console.log(`  🔘 Fallback: clicking primary button "${txt.trim()}"`);
          await anyPrimary.click({ force: true });
          clickedSomething = true;
          await page.waitForTimeout(2000);
        }
      }

      if (!clickedSomething) {
        throw new Error(`No Submit or Next button found on step ${stepCount}`);
      }
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
  writeFileSync('WAITING_FOR_SECURITY_CODE.txt', `Check email for code from ${companyName}, then run: echo "CODE" > security_code.txt`);

  // macOS notification + terminal bell
  import('child_process').then(({ execSync }) => {
    try { execSync(`osascript -e 'display notification "Check email: code needed for ${safeCompany}" with title "JobAuto: OTP Required" sound name "Glass"'`); } catch(e) {}
  }).catch(() => {});
  process.stdout.write('\x07'); // terminal bell
  console.log(`  ⏳ Gmail OTP watcher active — waiting up to 10 min for code from ${companyName}...`);

  let code = '';
  const securityDeadline = Date.now() + 10 * 60 * 1000;
  while (true) {
    if (Date.now() > securityDeadline) {
      console.log('  ⏰ Security code timeout (10 min) — marking as security_required and continuing...');
      try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch(e){}
      if (supabase) {
        try { await supabase.from('jobs').update({ status: 'security_required', notes: 'Email verification required' }).eq('id', job.id); } catch(e) {}
        try { await supabase.from('applications').insert({ job_id: job.id, eval_id: job.eval_id, status: 'security_required', notes: 'Paused: email verification code needed' }); } catch(e) {}
      }
      throw new Error('Security code required — retried manually');
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

  console.log(`  ✅ Received security code! Filling it in...`);
  for (let i = 0; i < code.length && i < 8; i++) {
    const input = await page.$(`#security-input-${i}`).catch(() => null);
    if (input) {
      await input.type(code[i], { delay: 50 });
    }
  }

  try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch(e){}
  try { unlinkSync('security_code.txt'); } catch(e){}

  await page.waitForTimeout(1000);
  console.log(`  🔘 Clicking SUBMIT again after security code`);
  await submitBtn.click();
  await page.waitForTimeout(1500);
}
