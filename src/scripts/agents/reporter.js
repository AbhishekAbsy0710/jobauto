/**
 * agents/reporter.js — Discord Notification Agent
 * 
 * Handles all Discord webhook notifications:
 * - Per-job success/failure embeds
 * - Run summary embed
 * - Error screenshots
 * 
 * Exports:
 *   - sendDiscordEmbed(embed) — raw embed send
 *   - reportApplied(job, supabase) — success notification + DB insert
 *   - reportFailed(job, supabase) — failure notification + DB insert
 *   - sendRunSummary(results, appliedJobs, failedJobs) — end-of-run summary
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { DISCORD_WEBHOOK, RESUME_PATH } from './constants.js';

// ── Raw Discord Embed ──────────────────────────────────────────────────────────
export async function sendDiscordEmbed(embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
  } catch {}
}

// ── Report Successful Application ──────────────────────────────────────────────
/**
 * Record a successful application to Supabase and send Discord notification.
 * @param {object} job - Job object with title, company, apply_link, etc.
 * @param {object} supabase - Supabase client
 * @param {object} opts - Additional options
 * @param {string} opts.proofScreenshotPath - Path to proof screenshot
 * @param {object} opts.coldEmail - Cold email info { sent, subject, body }
 */
export async function reportApplied(job, supabase, opts = {}) {
  const { proofScreenshotPath, coldEmail = {} } = opts;

  // Upload proof screenshot
  let proofUrl = null;
  if (proofScreenshotPath && existsSync(proofScreenshotPath)) {
    try {
      const screenshotBuffer = readFileSync(proofScreenshotPath);
      const fileName = `proof_${job.eval_id}_${Date.now()}.jpeg`;
      await supabase.storage.from('screenshots').upload(fileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
      proofUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
    } catch (err) {
      console.log(`  ⚠️ Failed to upload proof screenshot: ${err.message}`);
    }
  }

  // Insert application record
  await supabase.from('applications').insert({
    evaluation_id: job.eval_id,
    method: 'auto_browser',
    status: 'applied',
    pdf_path: job.tailoredPublicUrl || null,
    screenshot_url: proofUrl || null,
    applied_at: new Date().toISOString()
  });

  // Update job status
  await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);

  // Discord notification
  const coldEmailStatus = coldEmail.sent ? '✅ Sent' : '❌ Not sent';
  const fields = [
    { name: '🏢 Company', value: job.company || '—', inline: true },
    { name: '📍 Location', value: job.location || 'Europe', inline: true },
    { name: '⭐ ATS Score', value: `**${job.score ? job.score.toFixed(1) : '?'} / 5.0**`, inline: true },
    { name: '🔗 Apply Link', value: `[Open Job](${job.apply_link})`, inline: true },
    { name: '📄 Resume', value: job.resumeUsed || basename(RESUME_PATH), inline: true },
    { name: '📧 Cold Email', value: coldEmailStatus, inline: true },
  ];

  if (coldEmail.sent && coldEmail.subject) {
    fields.push({ name: '✉️ Subject', value: coldEmail.subject.substring(0, 256), inline: false });
    if (coldEmail.body) {
      fields.push({ name: '📝 Body', value: `\`\`\`text\n${coldEmail.body.substring(0, 1000)}\n\`\`\``, inline: false });
    }
  }

  await sendDiscordEmbed({
    title: `✅ Auto-Applied: ${job.title}`,
    description: `Successfully applied to **${job.company}**!${job.needsEmailVerification ? '\n\n⚠️ **ATTENTION:** Email verification required — check inbox!' : ''}`,
    color: 0x00d2a0,
    fields,
    image: proofUrl ? { url: proofUrl } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto — Auto-Applied ✅' }
  });
  await new Promise(r => setTimeout(r, 500));
}

// ── Report Failed Application ──────────────────────────────────────────────────
/**
 * Record a failed application to Supabase and send Discord notification.
 * @param {object} job - Job object
 * @param {object} supabase - Supabase client
 */
export async function reportFailed(job, supabase) {
  // Upload error screenshot
  let errorProofUrl = null;
  if (job.errorScreenshotPath && existsSync(job.errorScreenshotPath)) {
    try {
      const screenshotBuffer = readFileSync(job.errorScreenshotPath);
      const fileName = `error_${job.eval_id}_${Date.now()}.jpeg`;
      await supabase.storage.from('screenshots').upload(fileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
      errorProofUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
    } catch (err) {}
  }

  const failureReason = job.hasCaptcha ? 'Captcha Blocked' : (job.errorMessage || 'Validation Error');

  // Insert failure record
  await supabase.from('applications').insert({
    evaluation_id: job.eval_id,
    method: failureReason.substring(0, 100),
    status: 'failed',
    pdf_path: job.tailoredPublicUrl || null,
    screenshot_url: errorProofUrl || null,
    applied_at: new Date().toISOString()
  });

  // Update job status to manual_queue
  await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id);

  // Discord notification
  await sendDiscordEmbed({
    title: `❌ Auto-Apply Failed: ${job.title}`,
    description: `Failed to apply to **${job.company}** — moved to Manual Queue.`,
    color: 0xff4500,
    fields: [
      { name: '🏢 Company', value: job.company || '—', inline: true },
      { name: '⭐ ATS Score', value: `${job.score ? job.score.toFixed(1) : '?'} / 5.0`, inline: true },
      { name: '❌ Reason', value: failureReason.substring(0, 200), inline: false },
      { name: '👉 Apply Manually', value: `[Click Here](${job.apply_link})`, inline: false },
    ],
    image: errorProofUrl ? { url: errorProofUrl } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto — Manual Apply Required ⚠️' }
  });
  await new Promise(r => setTimeout(r, 500));
}

// ── Run Summary ────────────────────────────────────────────────────────────────
/**
 * Send end-of-run summary to Discord.
 */
export async function sendRunSummary(results) {
  const { applied, failed, skipped } = results;
  const total = applied + failed + skipped;
  
  if (total === 0) return;

  await sendDiscordEmbed({
    title: '📊 Auto-Apply Run Complete',
    description: `Processed **${total}** jobs`,
    color: applied > 0 ? 0x00d2a0 : 0xff4500,
    fields: [
      { name: '✅ Applied', value: String(applied), inline: true },
      { name: '❌ Failed', value: String(failed), inline: true },
      { name: '⏭️ Skipped', value: String(skipped), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto — Run Summary' }
  });
}
