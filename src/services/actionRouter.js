import { evaluateJob } from './evaluator.js';
import { applyBusinessRules } from './scorer.js';
import { getNewJobs, getResume, insertEvaluation, updateJobStatus } from '../database.js';
import { loadCV, loadConfig } from '../config.js';
// Uses native fetch (Node 18+)

/**
 * Career-Ops Pipeline:
 * Evaluate → Grade → Notify Discord → Update DB
 * Auto-apply is triggered separately via /api/auto-apply
 */
export async function evaluateNewJobs(limit = 20, concurrency = 1) {
  const resume = getResume();
  const cvContent = loadCV() || resume?.content;
  const config = loadConfig();

  if (!cvContent) {
    console.log('❌ No resume found — add resume/cv.md or resume/resume.txt');
    return { evaluated: 0, applied: 0, errors: 0 };
  }

  const newJobs = getNewJobs(limit);
  if (newJobs.length === 0) {
    console.log('✅ No new jobs to evaluate');
    return { evaluated: 0, applied: 0, errors: 0 };
  }

  console.log(`\n🤖 Evaluating ${newJobs.length} jobs (concurrency: ${concurrency})...\n`);

  let evaluated = 0, errors = 0;

  for (let i = 0; i < newJobs.length; i += concurrency) {
    const batch = newJobs.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(newJobs.length / concurrency);

    console.log(`\n📦 Batch ${batchNum}/${totalBatches} (${batch.length} jobs)`);

    const results = await Promise.allSettled(
      batch.map(job => processJob(job, cvContent, resume, config))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled' && results[j].value) {
        evaluated++;
      } else {
        errors++;
      }
    }

    if (i + concurrency < newJobs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n📊 Done: ${evaluated} evaluated, ${errors} errors`);
  return { evaluated, errors };
}

async function processJob(job, cvContent, resume, config) {
  try {
    console.log(`  📌 ${job.title} at ${job.company}`);

    // Step 1: AI Evaluation
    const aiResult = await evaluateJob(cvContent, job);
    if (!aiResult) {
      console.log('    ⚠️ AI returned no result');
      return null;
    }

    // Step 2: Business rules
    const finalResult = applyBusinessRules(aiResult, job);
    if (!finalResult) return null;

    // Step 3: Save evaluation
    insertEvaluation({
      job_id: job.id,
      resume_id: resume?.id || 1,
      match_percentage: finalResult.match_percentage,
      ranking_score: finalResult.ranking_score,
      skill_depth_score: finalResult.skill_depth_score,
      role_alignment_score: finalResult.role_alignment_score,
      letter_grade: finalResult.letter_grade,
      weighted_score: finalResult.weighted_score,
      archetype: finalResult.archetype,
      dimension_scores: finalResult.dimension_scores,
      star_stories: finalResult.star_stories,
      priority: finalResult.priority,
      risk_level: finalResult.risk_level,
      action: finalResult.action,
      matching_skills: finalResult.matching_skills,
      missing_skills: finalResult.missing_skills,
      resume_improvements: finalResult.resume_improvements,
      reason: finalResult.reason,
      raw_response: aiResult
    });

    const grade = finalResult.letter_grade;
    const score = finalResult.weighted_score;
    console.log(`    ✅ Grade: ${grade} (${score}/5) | ${finalResult.archetype} | ${finalResult.action}`);

    // Step 4: Update status
    const statusMap = { Skip: 'archived', Apply: 'auto_queue', Review: 'manual_queue' };
    updateJobStatus(job.id, statusMap[finalResult.action] || 'evaluated');

    // Step 5: Auto-apply for Grade A/B (Greenhouse, Lever, Ashby)
    let appResult = null;
    if (['A', 'B'].includes(grade) && finalResult.action === 'Apply') {
      try {
        const { processApplication } = await import('./autoApply.js');
        appResult = await processApplication(job, { ...finalResult, id: job.id });
        console.log(`    📬 Auto-apply: ${appResult.status}`);
      } catch (e) {
        console.log(`    ⚠️ Auto-apply skipped: ${e.message}`);
      }
    }

    // Step 6: Discord notification for Grade A/B
    if (['A', 'B'].includes(grade) && config.discordWebhookUrl) {
      await sendDiscordAlert(config, finalResult, job, appResult);
    }

    return finalResult;
  } catch (error) {
    console.error(`    ❌ Error: ${error.message}`);
    return null;
  }
}

// ============================================
// INLINE DISCORD ALERT (no Playwright dependency)
// ============================================
async function sendDiscordAlert(config, evaluation, job, appResult = null) {
  const gradeColor = { A: 0x00d2a0, B: 0x4da6ff, C: 0xffd93d, D: 0xff9f43, F: 0xff5252 };
  const title = encodeURIComponent(job.title || '');
  const company = encodeURIComponent(job.company || '');
  const location = encodeURIComponent(job.location || 'Europe');

  const crossLinks = [
    `[LinkedIn](https://www.linkedin.com/jobs/search/?keywords=${title}+${company}&location=${location})`,
    `[Indeed](https://www.indeed.com/jobs?q=${title}+${company}&l=${location})`,
    `[Glassdoor](https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${title}+${company})`,
    `[Xing](https://www.xing.com/jobs/search?keywords=${title}&location=${location})`,
    `[StepStone](https://www.stepstone.de/jobs/${(job.title || '').replace(/\s+/g, '-').toLowerCase()})`,
  ].join(' · ');

  // Application status field
  let appStatus = '⏳ Queued for review';
  if (appResult) {
    if (appResult.status === 'submitted') appStatus = '✅ AUTO-APPLIED! Resume + cover letter submitted';
    else if (appResult.status === 'manual') appStatus = `👋 Manual apply needed (${appResult.reason || job.platform})`;
    else if (appResult.status === 'error') appStatus = `❌ Failed: ${appResult.error || 'unknown'}`;
    else if (appResult.status === 'skipped') appStatus = '⏸️ Auto-apply disabled';
  }

  const embed = {
    title: `${evaluation.letter_grade === 'A' ? '🏆' : '🔥'} Grade ${evaluation.letter_grade} — ${job.title}`,
    description: `**${job.company}** · 📍 ${job.location || 'N/A'}`,
    color: gradeColor[evaluation.letter_grade] || 0x666666,
    fields: [
      { name: '⭐ Score', value: `${evaluation.weighted_score}/5.0`, inline: true },
      { name: '🏷️ Type', value: evaluation.archetype || 'Unknown', inline: true },
      { name: '🎯 Action', value: evaluation.action || 'Review', inline: true },
      { name: '✅ Matching Skills', value: (evaluation.matching_skills || []).slice(0, 5).join(', ') || 'N/A', inline: false },
      { name: '❌ Skill Gaps', value: (evaluation.missing_skills || []).slice(0, 3).join(', ') || 'None', inline: false },
      { name: '📬 Application', value: appStatus, inline: false },
      { name: '💡 Assessment', value: (evaluation.reason || 'N/A').slice(0, 200), inline: false },
      { name: '🔗 Apply', value: `[Direct Apply](${job.apply_link}) · ${crossLinks}`, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `JobAuto v2 · ${job.platform}` }
  };

  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] }),
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok || res.status === 204) {
      console.log(`    💬 Discord alert sent`);
    } else {
      console.log(`    ⚠️ Discord ${res.status}`);
    }
  } catch (e) {
    console.log(`    ⚠️ Discord failed: ${e.message}`);
  }
}
