// Uses native fetch (Node 18+)
import { loadConfig } from '../config.js';

/**
 * Multi-channel notification: Telegram + Discord
 * Sends grade alerts for A/B jobs and daily summaries.
 */

export async function sendTelegramNotification(evaluation, job) {
  // Send to all configured channels in parallel
  await Promise.allSettled([
    sendToTelegram(evaluation, job),
    sendToDiscord(evaluation, job)
  ]);
}

// ============================================
// TELEGRAM
// ============================================
async function sendToTelegram(evaluation, job) {
  const config = loadConfig();
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const ge = gradeEmoji(evaluation.letter_grade);
  const ae = actionEmoji(evaluation.action);
  const crossLinks = buildCrossLinks(job);

  const message = `${ge} *Grade ${evaluation.letter_grade}* — ${evaluation.weighted_score}/5.0

📌 *${esc(job.title)}*
🏢 ${esc(job.company)} — 📍 ${esc(job.location || 'N/A')}
🏷️ ${esc(evaluation.archetype || 'Unknown')}

⚠️ Risk: *${esc(evaluation.risk_level)}*
🎯 Priority: *${esc(evaluation.priority)}*
${ae} Action: *${esc(evaluation.action)}*

✅ *Match:* ${esc((evaluation.matching_skills || []).slice(0, 5).join(', ') || 'None')}
❌ *Gaps:* ${esc((evaluation.missing_skills || []).slice(0, 3).join(', ') || 'None')}

💡 ${esc(evaluation.reason || 'N/A')}

👉 [Direct Apply](${job.apply_link})
${crossLinks.map(l => `🔗 [${esc(l.name)}](${l.url})`).join('\n')}`;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });

    if (response.ok) {
      console.log(`  📱 Telegram: Grade ${evaluation.letter_grade} alert sent`);
    } else {
      const err = await response.json();
      console.log(`  ⚠️ Telegram error: ${err.description}`);
    }
  } catch (error) {
    console.error(`  ❌ Telegram failed: ${error.message}`);
  }
}

// ============================================
// DISCORD
// ============================================
async function sendToDiscord(evaluation, job) {
  const config = loadConfig();
  if (!config.discordWebhookUrl) return;

  const crossLinks = buildCrossLinks(job);
  const gradeColor = { A: 0x00d2a0, B: 0x4da6ff, C: 0xffd93d, D: 0xff9f43, F: 0xff5252 };

  const embed = {
    title: `${gradeEmoji(evaluation.letter_grade)} Grade ${evaluation.letter_grade} — ${job.title}`,
    description: `**${job.company}** · 📍 ${job.location || 'N/A'}`,
    color: gradeColor[evaluation.letter_grade] || 0x666666,
    fields: [
      { name: '⭐ Score', value: `${evaluation.weighted_score}/5.0`, inline: true },
      { name: '🏷️ Type', value: evaluation.archetype || 'Unknown', inline: true },
      { name: '🎯 Action', value: evaluation.action || 'Review', inline: true },
      { name: '✅ Matching Skills', value: (evaluation.matching_skills || []).slice(0, 5).join(', ') || 'None', inline: false },
      { name: '❌ Skill Gaps', value: (evaluation.missing_skills || []).slice(0, 3).join(', ') || 'None', inline: false },
      { name: '💡 Assessment', value: (evaluation.reason || 'N/A').slice(0, 200), inline: false },
      { name: '🔗 Apply Links', value: [
          `[Direct Apply](${job.apply_link})`,
          ...crossLinks.map(l => `[${l.name}](${l.url})`)
        ].join(' · '), inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto v2 CareerOps' }
  };

  try {
    const response = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'JobAuto',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/3135/3135692.png',
        embeds: [embed]
      })
    });

    if (response.ok || response.status === 204) {
      console.log(`  💬 Discord: Grade ${evaluation.letter_grade} alert sent`);
    } else {
      console.log(`  ⚠️ Discord error: ${response.status}`);
    }
  } catch (error) {
    console.error(`  ❌ Discord failed: ${error.message}`);
  }
}

// ============================================
// DAILY SUMMARY (both channels)
// ============================================
export async function sendDailySummary(stats) {
  await Promise.allSettled([
    sendDailySummaryTelegram(stats),
    sendDailySummaryDiscord(stats)
  ]);
}

async function sendDailySummaryTelegram(stats) {
  const config = loadConfig();
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const gradeList = (stats.grades || []).map(g => `${g.letter_grade}: ${g.count}`).join(' | ') || 'None';

  const message = `📊 *Daily CareerOps Summary*

📦 Total: ${stats.total_jobs} | 🆕 New: ${stats.new_jobs}
🚀 Apply: ${stats.auto_apply} | 👋 Review: ${stats.manual_apply} | 🗄️ Skip: ${stats.ignored}
✅ Applied: ${stats.applied} | 🎤 Interviews: ${stats.interviews}
📈 Grades: ${gradeList}
⭐ Avg: ${stats.avg_match}/5.0`;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: message, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error('  ❌ Telegram summary failed:', e.message); }
}

async function sendDailySummaryDiscord(stats) {
  const config = loadConfig();
  if (!config.discordWebhookUrl) return;

  const gradeList = (stats.grades || []).map(g => `${g.letter_grade}: ${g.count}`).join(' | ') || 'None';

  const embed = {
    title: '📊 Daily CareerOps Summary',
    color: 0x6c5ce7,
    fields: [
      { name: '📦 Total', value: `${stats.total_jobs}`, inline: true },
      { name: '🚀 Apply', value: `${stats.auto_apply}`, inline: true },
      { name: '👋 Review', value: `${stats.manual_apply}`, inline: true },
      { name: '✅ Applied', value: `${stats.applied}`, inline: true },
      { name: '🎤 Interviews', value: `${stats.interviews}`, inline: true },
      { name: '⭐ Avg Score', value: `${stats.avg_match}/5`, inline: true },
      { name: '📈 Grades', value: gradeList, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto v2 CareerOps' }
  };

  try {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
  } catch (e) { console.error('  ❌ Discord summary failed:', e.message); }
}

// ============================================
// CROSS-PLATFORM APPLY LINKS
// ============================================
function buildCrossLinks(job) {
  const title = encodeURIComponent(job.title || '');
  const company = encodeURIComponent(job.company || '');
  const location = encodeURIComponent(job.location || 'Europe');
  const query = encodeURIComponent(`${job.title} ${job.company}`);

  return [
    { name: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${title}+${company}&location=${location}` },
    { name: 'Indeed', url: `https://www.indeed.com/jobs?q=${title}+${company}&l=${location}` },
    { name: 'Glassdoor', url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${query}` },
    { name: 'Xing', url: `https://www.xing.com/jobs/search?keywords=${title}&location=${location}` },
    { name: 'StepStone', url: `https://www.stepstone.de/jobs/${title.replace(/%20/g, '-')}` },
  ];
}

// ============================================
// HELPERS
// ============================================
function gradeEmoji(grade) {
  return { A: '🏆', B: '🔥', C: '⚡', D: '📋', F: '⛔' }[grade] || '📋';
}

function actionEmoji(action) {
  return { Apply: '🚀', Review: '👋', Skip: '🗄️' }[action] || '📋';
}

function esc(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

// ============================================
// AUTO-APPLY NOTIFICATIONS
// ============================================

export async function sendApplicationNotification(evaluation, job, appResult) {
  const config = loadConfig();
  if (!config.discordWebhookUrl) return;

  const embed = {
    title: `✅ Application Submitted — ${job.title}`,
    description: `**${job.company}** · 📍 ${job.location || 'Europe'}\nGrade: **${evaluation.letter_grade}** (${evaluation.weighted_score}/5)`,
    color: 0x00d2a0,
    fields: [
      { name: '📄 Resume', value: `Tailored PDF generated`, inline: true },
      { name: '✉️ Cover Letter', value: 'AI-generated, personalized', inline: true },
      { name: '🤖 Platform', value: job.platform, inline: true },
      { name: '✅ Skills Matched', value: (evaluation.matching_skills || []).slice(0, 5).join(', ') || 'N/A', inline: false },
      { name: '💡 Assessment', value: (evaluation.reason || 'N/A').slice(0, 200), inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto v2 — Auto-Applied ✅' }
  };

  try {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
    console.log(`  💬 Discord: Sent auto-apply confirmation`);
  } catch (e) { console.error('  ❌ Discord apply notification failed:', e.message); }
}

export async function sendManualApplyNotification(evaluation, job, appResult) {
  const config = loadConfig();
  if (!config.discordWebhookUrl) return;

  const crossLinks = buildCrossLinks(job);
  const linkText = [
    `[🔗 Direct Apply](${job.apply_link})`,
    ...crossLinks.map(l => `[${l.name}](${l.url})`)
  ].join(' · ');

  const embed = {
    title: `👋 Manual Apply Needed — ${job.title}`,
    description: `**${job.company}** · 📍 ${job.location || 'Europe'}\nGrade: **${evaluation.letter_grade}** (${evaluation.weighted_score}/5)`,
    color: 0xffd93d,
    fields: [
      { name: '📄 Tailored PDF', value: appResult.pdfFilename || 'Generated', inline: true },
      { name: '🏷️ Type', value: evaluation.archetype || 'Unknown', inline: true },
      { name: '⚠️ Reason', value: appResult.reason || 'Platform requires manual submission', inline: false },
      { name: '✅ Matching Skills', value: (evaluation.matching_skills || []).slice(0, 5).join(', ') || 'N/A', inline: false },
      { name: '🔗 Apply Links', value: linkText, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'JobAuto v2 — Ready for manual apply 📄' }
  };

  try {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
    console.log(`  💬 Discord: Sent manual-apply notification`);
  } catch (e) { console.error('  ❌ Discord manual notification failed:', e.message); }
}
