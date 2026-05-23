/**
 * agents/verification-agent.js — Post-Submit Verification Agent
 * 
 * Verifies whether a job application was actually submitted successfully.
 * Checks for: success signals, error signals, captchas, spam blocks,
 * application rate limits, and URL changes.
 * 
 * Exports:
 *   - verifySubmission(page, preSubmitUrl, job) → VerificationResult
 */

import { writeFileSync } from 'fs';
import { healAndRetry } from './llm-client.js';
import { SUBMIT_SELECTORS } from './form-submitter.js';

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
 * @returns {VerificationResult}
 */
export async function verifySubmission(page, preSubmitUrl, job) {
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
  await page.screenshot({ path: 'debug_post_submit.png', fullPage: true });

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
    const healed = await healAndRetry(page, job);
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
    postSubmitLower.includes('required fields are missing')
  )) {
    console.log(`  ⚠️ Required field validation error detected in page text`);
    hasErrors = true;
  }

  // Self-heal validation errors
  if (hasErrors) {
    const html2 = await page.content();
    writeFileSync('datadog_error.html', html2);
    await page.screenshot({ path: 'datadog_error_screenshot.png', fullPage: true });
    console.log('  🔧 Validation errors detected — invoking self-healing agent...');
    const healed = await healAndRetry(page, job);
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
  const leverSuccess = isLever && !hasErrors && (
    postSubmitLower.includes('application has been submitted') ||
    postSubmitLower.includes('your application was submitted') ||
    postSubmitLower.includes('thanks for applying') ||
    postSubmitLower.includes("we'll be in touch") ||
    postSubmitLower.includes('we received your application') ||
    submitButtonGone
  );
  const ashbySuccess = isAshby && !hasErrors && submitButtonGone;

  // Final verdict
  const isSuccess = !hasErrors && (isSuccessUrl || isSuccessText || (urlChanged && submitButtonGone) || leverSuccess || ashbySuccess);

  if (isSuccess) {
    console.log('  ✅ Application verified successful!');
    if (urlChanged) console.log(`  📍 Redirected: ${preSubmitUrl.substring(0,50)} → ${url.substring(0,50)}`);
  }

  return {
    success: isSuccess,
    hasCaptcha: false,
    needsEmailVerification,
    hasErrors,
    failureReason: isSuccess ? '' : (hasErrors ? 'Validation errors after submit' : 'No success confirmation detected'),
  };
}
