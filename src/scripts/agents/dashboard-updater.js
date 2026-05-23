/**
 * agents/dashboard-updater.js — Dashboard & Supabase Agent
 * 
 * Handles all Supabase database updates:
 * - Insert application records
 * - Update job status (applied, manual_queue, archived)
 * - Upload proof screenshots
 * - Cold email tracking
 * 
 * Exports:
 *   - recordSuccess(job, supabase, opts) — record successful application
 *   - recordFailure(job, supabase, opts) — record failed application
 *   - updateJobStatus(jobId, status, supabase, extra) — update job status
 *   - uploadProofScreenshot(page, job, supabase) — take and upload proof
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { RESUME_PATH, ROOT, PROFILE_YAML } from './constants.js';

const SUPABASE_SCREENSHOT_BUCKET = 'screenshots';
const SUPABASE_SCREENSHOT_BASE = 'https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots';

// ── Upload Proof Screenshot ──────────────────────────────────────────────────
/**
 * Take a screenshot and upload to Supabase storage.
 * @returns {string|null} Public URL of the screenshot
 */
export async function uploadProofScreenshot(page, job, supabase) {
  try {
    const proofId = job.eval_id || job.id;
    const screenshotPath = join(ROOT, `proof_${proofId}_${Date.now()}.jpeg`);
    await page.screenshot({ path: screenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
    const screenshotBuffer = readFileSync(screenshotPath);
    const proofFileName = `proof_${proofId}_${Date.now()}.jpeg`;
    await supabase.storage.from(SUPABASE_SCREENSHOT_BUCKET).upload(proofFileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
    const url = `${SUPABASE_SCREENSHOT_BASE}/${proofFileName}`;
    console.log(`  📸 Proof screenshot uploaded: ${proofFileName}`);
    return url;
  } catch (err) {
    console.log(`  ⚠️ Failed to upload proof screenshot: ${err.message}`);
    return null;
  }
}

// ── Upload Error Screenshot ──────────────────────────────────────────────────
export async function uploadErrorScreenshot(screenshotPath, job, supabase) {
  if (!screenshotPath || !existsSync(screenshotPath)) return null;
  try {
    const screenshotBuffer = readFileSync(screenshotPath);
    const fileName = `error_${job.eval_id}_${Date.now()}.jpeg`;
    await supabase.storage.from(SUPABASE_SCREENSHOT_BUCKET).upload(fileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
    return `${SUPABASE_SCREENSHOT_BASE}/${fileName}`;
  } catch { return null; }
}

// ── Record Successful Application ──────────────────────────────────────────────
/**
 * @param {object} job - Job object
 * @param {object} supabase - Supabase client
 * @param {object} opts
 * @param {string} opts.screenshotUrl - Proof screenshot URL
 * @param {string} opts.tailoredResumeUrl - Tailored resume URL
 * @param {string} opts.tailoredChanges - Description of resume changes
 * @param {string} opts.activeResumePath - Path to the resume file used
 */
export async function recordSuccess(job, supabase, opts = {}) {
  const { screenshotUrl, tailoredResumeUrl, tailoredChanges, activeResumePath } = opts;

  let methodCol = 'auto';
  if (tailoredChanges && tailoredChanges !== 'Base Resume (No modifications)') {
    methodCol = 'auto | ' + tailoredChanges.substring(0, 100);
  }

  // Insert application record
  const { data: appData } = await supabase.from('applications').insert({
    evaluation_id: job.eval_id,
    method: methodCol,
    status: 'submitted',
    pdf_path: tailoredResumeUrl || RESUME_PATH,
    screenshot_url: screenshotUrl,
    applied_at: new Date().toISOString()
  }).select('id').single();

  if (appData) {
    job.app_id = appData.id;
    job.screenshotUrl = screenshotUrl;
  }
  job.resumeUsed = basename(activeResumePath || RESUME_PATH);

  // Update jobs table with proof and resume URLs
  try {
    const { error: upErr } = await supabase.from('jobs').update({
      status: 'applied',
      proof_url: screenshotUrl || null,
      tailored_resume_url: tailoredResumeUrl || null,
      applied_at: new Date().toISOString(),
    }).eq('id', job.id);
    if (upErr) {
      // Fallback: columns may not exist yet — just update status
      await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
    }
  } catch {
    try { await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id); } catch {}
  }

  return { appId: appData?.id, methodCol };
}

// ── Record Failed Application ──────────────────────────────────────────────────
export async function recordFailure(job, supabase, opts = {}) {
  const { errorScreenshotPath, tailoredResumeUrl } = opts;

  const errorProofUrl = await uploadErrorScreenshot(errorScreenshotPath, job, supabase);
  const failureReason = job.hasCaptcha ? 'Captcha Blocked' : (job.errorMessage || 'Validation Error');

  await supabase.from('applications').insert({
    evaluation_id: job.eval_id,
    method: failureReason.substring(0, 100),
    status: 'failed',
    pdf_path: tailoredResumeUrl || null,
    screenshot_url: errorProofUrl || null,
    applied_at: new Date().toISOString()
  });

  await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id);

  return { errorProofUrl, failureReason };
}

// ── Update Job Status ──────────────────────────────────────────────────────────
export async function updateJobStatus(jobId, status, supabase, extra = {}) {
  await supabase.from('jobs').update({ status, ...extra }).eq('id', jobId).catch(() => {});
}

// ── Track Cold Email ──────────────────────────────────────────────────────────
export async function trackColdEmail(job, supabase, activeResumePath) {
  try {
    const { sendColdEmail } = await import('../services/cold-email.js');
    const cvText = PROFILE_YAML;
    const emailResult = await sendColdEmail(job, null, cvText, activeResumePath);

    if (emailResult && emailResult.target) {
      job.coldEmailSent = true;
      job.coldEmailTarget = emailResult.target;
      job.coldEmailSubject = emailResult.subject;
      job.coldEmailBody = emailResult.body;
    } else {
      job.coldEmailSent = false;
      job.coldEmailError = 'AI generation failed or target blocked';
    }
  } catch (emailErr) {
    console.log(`  ⚠️ Cold email failed: ${emailErr.message}`);
    job.coldEmailSent = false;
    job.coldEmailError = emailErr.message;
  }

  // Persist cold email status
  try {
    const coldStr = job.coldEmailSent
      ? `COLD_EMAIL_SENT:${job.coldEmailTarget || ''}:${(job.coldEmailSubject||'').substring(0,80)}`
      : `COLD_EMAIL_SKIP:${(job.coldEmailError||'not sent').substring(0,80)}`;
    await supabase.from('applications')
      .update({ method: `auto ||| ${coldStr}` })
      .eq('evaluation_id', job.eval_id);
  } catch {}
}
