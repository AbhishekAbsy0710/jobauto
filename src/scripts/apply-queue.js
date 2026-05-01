#!/usr/bin/env node
// Apply all auto_queue jobs via Greenhouse/Lever/Ashby APIs
import Database from 'better-sqlite3';
import { processApplication } from '../services/autoApply.js';

process.env.AUTO_APPLY_MODE = 'auto';
const db = new Database('./db/jobauto.db');

const jobs = db.prepare(`
  SELECT j.*, e.id as eval_id, e.letter_grade, e.weighted_score, e.matching_skills, e.reason
  FROM jobs j JOIN evaluations e ON e.job_id = j.id
  WHERE j.status = 'auto_queue' AND j.platform IN ('greenhouse','lever','ashby')
  ORDER BY e.weighted_score DESC
`).all();

console.log(`\n🚀 Auto-applying to ${jobs.length} jobs...\n`);

for (const job of jobs) {
  console.log(`--- ${job.title} @ ${job.company} (${job.platform} · ${job.location})`);
  try {
    const result = await processApplication(job, { ...job, id: job.eval_id });
    console.log(`    📬 ${result.status}${result.error ? ' — ' + result.error : ''}`);
  } catch (e) {
    console.log(`    ❌ ${e.message}`);
  }
}

db.close();
console.log('\n✅ Done');
process.exit(0);
