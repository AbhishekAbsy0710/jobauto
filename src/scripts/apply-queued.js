/**
 * Apply all jobs stuck in auto_queue status.
 * These were evaluated as Grade A/B but never got submitted.
 */
import { initializeDb, getDb, updateJobStatus } from '../database.js';
import { processApplication } from '../services/autoApply.js';

initializeDb();
const db = getDb();

// Get all auto_queue jobs with their evaluations
const queued = db.prepare(`
  SELECT j.*, e.letter_grade, e.weighted_score, e.archetype, e.action, e.reason,
         e.matching_skills, e.missing_skills, e.id as eval_id
  FROM jobs j 
  JOIN evaluations e ON j.id = e.job_id
  WHERE j.status = 'auto_queue' AND e.action = 'Apply'
  ORDER BY e.weighted_score DESC
`).all();

console.log(`\n📋 Found ${queued.length} jobs in auto_queue\n`);

let applied = 0, failed = 0;

for (const job of queued) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📌 ${job.title} at ${job.company}`);
  console.log(`   Grade: ${job.letter_grade} (${job.weighted_score}/5) | ${job.archetype}`);
  console.log(`   Location: ${job.location}`);
  
  try {
    const evaluation = {
      id: job.eval_id,
      letter_grade: job.letter_grade,
      weighted_score: job.weighted_score,
      archetype: job.archetype,
      action: job.action,
      reason: job.reason,
      matching_skills: JSON.parse(job.matching_skills || '[]'),
      missing_skills: JSON.parse(job.missing_skills || '[]'),
    };

    const result = await processApplication(job, evaluation);
    
    if (result.status === 'submitted') {
      console.log(`   ✅ APPLIED — dispatched to n8n`);
      applied++;
    } else if (result.status === 'manual') {
      console.log(`   👋 MANUAL — ${result.reason}`);
    } else {
      console.log(`   ❌ FAILED — ${result.error || 'unknown'}`);
      failed++;
    }
  } catch (e) {
    console.log(`   ❌ ERROR — ${e.message}`);
    failed++;
  }
  
  // Wait between applications to avoid rate limits on resume tailoring
  await new Promise(r => setTimeout(r, 2000));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`📊 Done: ${applied} applied, ${failed} failed, ${queued.length - applied - failed} manual`);
process.exit(0);
