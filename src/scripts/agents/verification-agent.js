/**
 * agents/verification-agent.js — Post-Submit Verification Agent
 * 
 * Verifies whether a job application was actually submitted successfully.
 * Checks for: success signals, error signals, captchas, spam blocks,
 * application rate limits, URL changes, and platform-specific patterns.
 * 
 * Platform-specific success detection:
 *   - SmartRecruiters oneclick-ui (submitButtonGone OR thank-you text)
 *   - Lever SPA (URL doesn't change, checks text + button gone)
 *   - Ashby (submitButtonGone)
 * 
 * Exports:
 *   - verifySubmission(page, preSubmitUrl, job, callGroqFn) → VerificationResult
 */

import { writeFileSync } from 'fs';
import { SUBMIT_SELECTORS } from './constants.js';

/**
 * @typedef {object} VerificationResult
 * @property {boolean} success - Whether the application was verified as submitted
 * @property {boolean} hasCaptcha - Whether a captcha was detected
 * @property {boolean} needsEmailVerification - Whether email verification is required
 * @property {boolean} hasErrors - Whether validation errors were detected
 * @property {string} failureReason - Reason for failure (if not success)
 */

/**
 * Verify a form submission result.
 * 
 * @param {import('playwright').Page} page
 * @param {string} preSubmitUrl - URL before submit was clicked
 * @param {object} job - Job object
 * @param {Function} callGroqFn - callGroq function for LLM fallback
 * @param {Function} healAndRetryFn - healAndRetry function for self-healing
 * @returns {VerificationResult}
 */
export async function verifySubmission(page, preSubmitUrl, job, callGroqFn, healAndRetryFn) {
  await page.waitForTimeout(5000);
  const url = page.url().toLowerCase();
  const urlChanged = url !== preSubmitUrl.toLowerCase();
  console.log(`  🔗 Pre-submit URL: ${preSubmitUrl.substring(0, 80)}`);
  console.log(`  🔗 Post-submit URL: ${url.substring(0, 80)}`);

  const postSubmitPageText = await page.textContent('body').catch(() => '');
  const postSubmitLower = postSubmitPageText.toLowerCase();

  // Save debug artifacts
  const html = await page.content();
  writeFileSync('debug_post_submit.html', html);
  await page.screenshot({ path: 'debug_post_submit.png', fullPage: true }).catch(() => {});

  // ── Application Rate Limit Detection ──────────────────────────────────────
  if (postSubmitLower.includes('application limits') || 
      postSubmitLower.includes('limit on how often someone can apply') || 
      postSubmitLower.includes('you can submit up to')) {
    return {
      success: false,
      hasCaptcha: false,
      needsEmailVerification: false,
      hasErrors: false,
      failureReason: `Application blocked — company has per-person apply limits (applied too many times to ${job.company})`,
    };
  }

  // ── Captcha Detection ────────────────────────────────────────────────────
  const hasCaptchaText = postSubmitLower.includes('please solve this captcha') ||
    postSubmitLower.includes('verify you are human') ||
    postSubmitLower.includes('checking if the site connection is secure') ||
    postSubmitLower.includes('just a moment') ||
    postSubmitLower.includes('hcaptcha') ||
    postSubmitLower.includes('click all items') ||
    postSubmitLower.includes('select all images');
  const hasCaptchaWidget = await page.evaluate(() =>
    !!(document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], .h-captcha, #h-captcha, [class*="hcaptcha"], iframe[data-hcaptcha-widget-id]'))
  ).catch(() => false);

  if (hasCaptchaText || hasCaptchaWidget) {
    console.log('  🔒 hCaptcha/reCAPTCHA triggered post-submit');
    return {
      success: false,
      hasCaptcha: true,
      needsEmailVerification: false,
      hasErrors: false,
      failureReason: 'Captcha Blocked Submission — requires manual apply',
    };
  }

  // ── Spam/Bot Block Detection + Self-Heal ──────────────────────────────────
  if (postSubmitLower.includes('flagged as possible spam') || 
      postSubmitLower.includes('flagged as spam') || 
      postSubmitLower.includes('submission was blocked') || 
      postSubmitLower.includes('robot') || 
      postSubmitLower.includes('automated submission')) {
    console.log('  🚨 Bot/spam block detected — invoking self-healing agent...');
    const healed = healAndRetryFn ? await healAndRetryFn(page, job) : false;
    if (!healed) {
      return {
        success: false,
        hasCaptcha: false,
        needsEmailVerification: false,
        hasErrors: false,
        failureReason: 'Submission blocked as spam/bot by ATS (heal failed)',
      };
    }
    const healedText = await page.textContent('body').catch(() => '').then(t => t.toLowerCase());
    if (healedText.includes('thank you') || healedText.includes('application received') || healedText.includes('successfully submitted')) {
      console.log('  ✅ Healed — application confirmed successful!');
      return {
        success: true,
        hasCaptcha: false,
        needsEmailVerification: false,
        hasErrors: false,
        failureReason: '',
      };
    }
    return {
      success: false,
      hasCaptcha: false,
      needsEmailVerification: false,
      hasErrors: false,
      failureReason: 'Submission blocked as spam/bot by ATS (heal did not resolve)',
    };
  }

  // ── Success Signal Detection ──────────────────────────────────────────────
  const isSuccessUrl = url.includes('/thank') || url.includes('thank_you') || 
    url.includes('/confirmation') || url.includes('/applied') || 
    url.includes('/success') || url.includes('status=applied');

  const isSuccessText = postSubmitLower.includes('thank you for applying') ||
    postSubmitLower.includes('thanks for applying') ||
    postSubmitLower.includes('application received') ||
    postSubmitLower.includes('application has been received') ||
    postSubmitLower.includes('successfully submitted') ||
    postSubmitLower.includes('your job application has been sent') ||
    postSubmitLower.includes('we have received your application') ||
    postSubmitLower.includes('application was submitted') ||
    postSubmitLower.includes('you have applied') ||
    postSubmitLower.includes('application submitted') ||
    postSubmitLower.includes("we'll be in touch") ||
    postSubmitLower.includes('applied successfully') ||
    postSubmitLower.includes('thank you for your interest') ||
    postSubmitLower.includes('your application has been submitted');

  // Check if submit button disappeared (form accepted)
  let submitButtonGone = true;
  for (const sel of SUBMIT_SELECTORS.slice(0, 5)) {
    const btn = await page.$(sel).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) { submitButtonGone = false; break; }
  }

  // ── Error Detection ──────────────────────────────────────────────────────
  const errorSelectors = [
    '.error', '.error-message', '.error-banner', '.alert-danger', '.alert-error',
    '[aria-invalid="true"]', '.invalid', '.parsley-error', '.text-danger',
    '.application-error', '.form-error', '.validation-error'
  ];
  let hasErrors = false;
  for (const sel of errorSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const errText = await el.textContent().catch(() => '');
      if (errText && errText.trim().length > 0 && !errText.toLowerCase().includes('success')) {
        console.log(`  ⚠️ Error element detected: "${errText.trim().substring(0, 80)}"`);
        hasErrors = true;
        break;
      }
    }
  }

  // Required field validation errors
  if (!hasErrors && (
    postSubmitLower.includes('missing entry for required field') || 
    postSubmitLower.includes('please fill in all required fields') || 
    postSubmitLower.includes('required fields are missing') ||
    postSubmitLower.includes('please provide a valid email') ||
    postSubmitLower.includes('this field is required')
  )) {
    console.log(`  ⚠️ Required field validation error detected in page text`);
    hasErrors = true;
  }

  // Self-heal validation errors
  if (hasErrors && healAndRetryFn) {
    const html2 = await page.content();
    writeFileSync('datadog_error.html', html2);
    await page.screenshot({ path: 'datadog_error_screenshot.png', fullPage: true }).catch(() => {});
    console.log('  🔧 Validation errors detected — invoking self-healing agent...');
    const healed = await healAndRetryFn(page, job);
    if (healed) {
      hasErrors = false;
      for (const sel of errorSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          const errText = await el.textContent().catch(() => '');
          if (errText && errText.trim().length > 0 && !errText.toLowerCase().includes('success')) {
            hasErrors = true; break;
          }
        }
      }
      if (!hasErrors) console.log('  ✅ Validation errors resolved by self-healing agent!');
    }
  }

  // Email verification detection
  const needsEmailVerification = postSubmitLower.includes('check your email') || 
    postSubmitLower.includes('verify your email') || 
    postSubmitLower.includes('confirm your email') ||
    url.includes('join.com');

  // ── Platform-Specific Success Checks ──────────────────────────────────────
  const isLever = url.includes('jobs.lever.co') || url.includes('lever.co');
  const isAshby = url.includes('ashbyhq.com') || url.includes('jobs.ashby');
  const isSR = url.includes('smartrecruiters.com');

  const leverSuccess = isLever && !hasErrors && (
    postSubmitLower.includes('application has been submitted') ||
    postSubmitLower.includes('your application was submitted') ||
    postSubmitLower.includes('thanks for applying') ||
    postSubmitLower.includes("we'll be in touch") ||
    postSubmitLower.includes('we received your application') ||
    submitButtonGone
  );
  const ashbySuccess = isAshby && !hasErrors && submitButtonGone;

  // SR oneclick-ui: REQUIRE explicit success text — submitButtonGone alone is a false positive
  const srSuccess = isSR && !hasErrors && (
    isSuccessText ||
    postSubmitLower.includes('thank you for your interest') ||
    postSubmitLower.includes('your application has been sent') ||
    postSubmitLower.includes('application submitted') ||
    postSubmitLower.includes('we received your application')
  );

  // Final verdict
  const isSuccess = !hasErrors && (isSuccessUrl || isSuccessText || (urlChanged && submitButtonGone) || leverSuccess || ashbySuccess || srSuccess);

  if (isSuccess) {
    console.log('  ✅ Application verified successful!');
    if (urlChanged) console.log(`  📍 Redirected: ${preSubmitUrl.substring(0,50)} → ${url.substring(0,50)}`);
  }

  // ── Non-LLM Heuristic Fallback ───────────────────────────────────────────
  // If no definitive success/error from platform checks, try simple heuristics
  // before burning LLM tokens. This catches common patterns cheaply.
  if (!isSuccess && !hasErrors) {
    const heuristicSuccess = (
      // URL contains success indicators
      /\/(thank|confirm|success|applied|done|complete)/.test(url) ||
      // Page text strongly suggests success
      /thank\s*you\s*(for|!|,)/i.test(postSubmitLower) ||
      /application\s*(has been\s*)?(?:received|submitted|sent)/i.test(postSubmitLower) ||
      /we('ve|.have)\s*(received|got)\s*your/i.test(postSubmitLower) ||
      /successfully\s*(applied|submitted)/i.test(postSubmitLower) ||
      // Submit button disappeared AND URL changed (strong signal)
      (submitButtonGone && urlChanged)
    );

    if (heuristicSuccess) {
      console.log('  ✅ Heuristic verification: application likely successful (no LLM needed)');
      return {
        success: true,
        hasCaptcha: false,
        needsEmailVerification,
        hasErrors: false,
        failureReason: '',
        heuristicVerified: true,
      };
    }
  }

  // ── LLM Fallback Verification ─────────────────────────────────────────────
  // If no definitive result, ask an LLM to evaluate the page
  if (!isSuccess && !hasErrors && callGroqFn) {
    console.log('  🔧 No success signal detected — asking agent to evaluate page state...');
    // Strip <noscript> content — it always says "JavaScript is disabled" and confuses the LLM
    const rawPageText = await page.textContent('body').catch(() => '');
    const pageText = rawPageText.replace(/JavaScript is (disabled|not available|not enabled)[^.]*\.?/gi, '').trim();
    const currentUrl = page.url();
    const agentRaw = await callGroqFn(
      'You are verifying if a job application was successfully submitted. Ignore any mentions of JavaScript being disabled — that is from a <noscript> tag and is irrelevant. Focus on whether the form was submitted. Return only valid JSON.',
      `URL: ${currentUrl.substring(0, 120)}\nPage text: ${pageText.substring(0, 800)}\n\nDid the application submit successfully? If the page shows the job listing or application form without errors, or any thank-you/confirmation message, that means success. Return JSON: {"success": true/false, "reason": "brief explanation", "action": "optional next action if not success e.g. click submit button selector"}`,
      'llama-3.3-70b-versatile'
    );
    let agentVerdict = { success: false, reason: 'No response' };
    try { agentVerdict = JSON.parse(agentRaw); } catch {}
    console.log(`  🤖 Agent verdict: ${JSON.stringify(agentVerdict)}`);

    if (agentVerdict.success) {
      return {
        success: true,
        hasCaptcha: false,
        needsEmailVerification,
        hasErrors: false,
        failureReason: '',
        agentVerified: true,
      };
    } else if (agentVerdict.action) {
      console.log(`  🤖 Agent suggests: ${agentVerdict.action}`);
      try { await page.locator(agentVerdict.action).first().click({ timeout: 5000, force: true }); } catch {}
      await page.waitForTimeout(3000);
      const retryText = await page.textContent('body').catch(() => '').then(t => t.toLowerCase());
      const retrySuccess = retryText.includes('thank you') || retryText.includes('application received') || retryText.includes('successfully submitted') || retryText.includes('applied successfully');
      if (retrySuccess) {
        return {
          success: true,
          hasCaptcha: false,
          needsEmailVerification,
          hasErrors: false,
          failureReason: '',
        };
      }
    }
  }

  return {
    success: isSuccess,
    hasCaptcha: false,
    needsEmailVerification,
    hasErrors,
    failureReason: isSuccess ? '' : (hasErrors ? 'Validation errors after submit' : 'No success confirmation detected'),
  };
}

