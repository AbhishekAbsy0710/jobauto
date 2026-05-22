/**
 * fix-applied-data.js
 * 
 * One-time migration script to:
 * 1. Add proof_url, tailored_resume_url, applied_at columns to jobs table
 * 2. Backfill links from applications → jobs
 * 3. Move non-IT / non-confirmed jobs from 'applied' → 'review'
 * 4. Fix applications status inconsistency (submitted → applied)
 * 
 * Run: node src/scripts/fix-applied-data.js
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

// Load env
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
env.split('\n').forEach(l => {
  const [k, ...v] = l.split('=');
  if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
});

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── STEP 1: Verify columns exist by trying to select them ───────────────────
console.log('\n🔧 STEP 1: Checking jobs table columns...');
const { data: testRow, error: colErr } = await sb
  .from('jobs')
  .select('id, proof_url, tailored_resume_url, applied_at')
  .limit(1);

if (colErr && colErr.message.includes('proof_url')) {
  console.log('  ❌ Columns proof_url/tailored_resume_url/applied_at are missing.');
  console.log('  ➡️  Please run this SQL in the Supabase SQL editor at:');
  console.log('     https://supabase.com/dashboard/project/swscpdtchfjyzpjhwqqj/editor');
  console.log('\n  SQL to run:\n');
  console.log(`  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS proof_url TEXT;`);
  console.log(`  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tailored_resume_url TEXT;`);
  console.log(`  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;`);
  console.log('\n  Then re-run this script.\n');
  process.exit(1);
} else {
  console.log('  ✅ Columns exist (or already added)');
}

// ─── STEP 2: Get all applied jobs ─────────────────────────────────────────────
console.log('\n🔧 STEP 2: Loading all applied jobs...');
const { data: appliedJobs } = await sb
  .from('jobs')
  .select('id, title, company, platform, proof_url, tailored_resume_url, applied_at, source_id')
  .eq('status', 'applied');
console.log(`  Found ${appliedJobs.length} jobs with status=applied`);

// ─── STEP 3: Get all submitted applications ────────────────────────────────────
console.log('\n🔧 STEP 3: Loading submitted applications...');
const { data: allApps } = await sb
  .from('applications')
  .select('*')
  .eq('status', 'submitted')
  .like('pdf_path', 'https://%');
console.log(`  Found ${allApps.length} submitted applications with valid PDF URLs`);

// Build a lookup: evaluation_id → app data
const appByEvalId = {};
for (const app of allApps) {
  if (app.evaluation_id && !appByEvalId[app.evaluation_id]) {
    appByEvalId[app.evaluation_id] = app;
  }
}

// ─── STEP 4: Backfill URLs from applications → jobs ──────────────────────────
console.log('\n🔧 STEP 4: Backfilling proof/resume URLs into jobs...');
let backfilled = 0;
let alreadyHas = 0;

for (const job of appliedJobs) {
  // Try matching by job.id (evaluation_id = job.id is the pattern used in browser-apply.js)
  const matchingApp = appByEvalId[job.id] || appByEvalId[job.source_id];
  
  if (!matchingApp) continue;

  const alreadyFilled = job.proof_url && job.tailored_resume_url;
  if (alreadyFilled) { alreadyHas++; continue; }

  const updateData = {};
  if (!job.tailored_resume_url && matchingApp.pdf_path?.startsWith('https://')) {
    updateData.tailored_resume_url = matchingApp.pdf_path;
  }
  if (!job.proof_url && matchingApp.screenshot_url?.startsWith('https://')) {
    updateData.proof_url = matchingApp.screenshot_url;
  }
  if (!job.applied_at && matchingApp.applied_at) {
    updateData.applied_at = matchingApp.applied_at;
  }

  if (Object.keys(updateData).length > 0) {
    const { error } = await sb.from('jobs').update(updateData).eq('id', job.id);
    if (!error) {
      backfilled++;
      console.log(`  ✅ Backfilled job ${job.id} (${job.title?.substring(0, 35)})`);
    } else {
      console.log(`  ⚠️  Failed job ${job.id}: ${error.message}`);
    }
  }
}
console.log(`  Backfilled: ${backfilled} | Already had links: ${alreadyHas}`);

// ─── STEP 5: Find the LATEST submitted app for each job ID ───────────────────
// (For the most recent applications that match by job.id directly)
console.log('\n🔧 STEP 5: Backfilling from recent applications (job.id match)...');
const { data: recentApps } = await sb
  .from('applications')
  .select('*')
  .eq('status', 'submitted')
  .like('pdf_path', 'https://%')
  .order('id', { ascending: false });

// Build job-id → latest app map by looking at the proof filename pattern: proof_<eval_id>_<timestamp>
const appByJobId = {};
for (const app of (recentApps || [])) {
  // proof filename: proof_<eval_id>_<ts>.jpeg
  // pdf filename: resume_<job_id>_<ts>.pdf
  const pdfMatch = app.pdf_path?.match(/resume_(\d+)_/);
  const jobId = pdfMatch ? parseInt(pdfMatch[1]) : null;
  if (jobId && !appByJobId[jobId]) {
    appByJobId[jobId] = app;
  }
}

let backfilled2 = 0;
const { data: stillMissingJobs } = await sb
  .from('jobs')
  .select('id, title, proof_url, tailored_resume_url, applied_at')
  .eq('status', 'applied')
  .is('tailored_resume_url', null);

for (const job of (stillMissingJobs || [])) {
  const app = appByJobId[job.id];
  if (!app) continue;

  const updateData = {
    tailored_resume_url: app.pdf_path,
    proof_url: app.screenshot_url || null,
    applied_at: app.applied_at || null,
  };
  const { error } = await sb.from('jobs').update(updateData).eq('id', job.id);
  if (!error) {
    backfilled2++;
    console.log(`  ✅ Backfilled2 job ${job.id} (${job.title?.substring(0, 35)})`);
  }
}
console.log(`  Backfilled via filename pattern: ${backfilled2}`);

// ─── STEP 6: Move non-IT / non-confirmed jobs to 'review' ────────────────────
console.log('\n🔧 STEP 6: Reclassifying non-IT or incorrectly applied jobs...');

// Jobs that SHOULD NOT be in applied (non-IT roles that slipped through)
const NON_IT_IDS = [
  442,  // Influencer Marketing Manager
  441,  // Youtube Influencer Marketing Manager (Werkstudent)
  1135, // Infrastructure Tax Lead
  1113, // AI Solutions Manager SMB (sales role)
  317,  // Engineering Manager, Platform (non-IC)
  314,  // Engineering Manager, Platform (non-IC) - duplicate
];

for (const jobId of NON_IT_IDS) {
  const { error } = await sb.from('jobs').update({ status: 'review' }).eq('id', jobId);
  if (!error) {
    console.log(`  📋 Moved job ${jobId} → review (non-IT/management role)`);
  } else {
    console.log(`  ⚠️  Could not move job ${jobId}: ${error.message}`);
  }
}

// Also fix US-only jobs that should not be applied (Anthropic SF/NY only roles)
// Keep IT ones that are remote-friendly, but flag US-only non-remote
const US_ONLY_IDS = [
  // Check: job 1136 Anthropic IT Systems Engineer - location: SF/Seattle/NYC but says remote-friendly
  // Keep as applied since it IS remote-friendly
  // Nothing to move here currently unless user says so
];

// ─── STEP 7: Fix applications table — normalize 'submitted' → 'applied' ──────
console.log('\n🔧 STEP 7: Normalizing applications.status submitted → applied...');
const { data: fixedApps, error: fixErr } = await sb
  .from('applications')
  .update({ status: 'applied' })
  .eq('status', 'submitted')
  .like('pdf_path', 'https://%')
  .select('id');
console.log(`  Normalized ${fixedApps?.length || 0} applications from submitted → applied`);

// ─── STEP 8: Final verification ───────────────────────────────────────────────
console.log('\n🔧 STEP 8: Final verification...');
const { data: finalApplied } = await sb
  .from('jobs')
  .select('id, title, company, proof_url, tailored_resume_url, applied_at')
  .eq('status', 'applied')
  .order('id', { ascending: false });

const { data: finalReview } = await sb
  .from('jobs')
  .select('id, title, company')
  .eq('status', 'review')
  .order('id', { ascending: false });

console.log(`\n📊 FINAL STATE:`);
console.log(`  ✅ Applied: ${finalApplied?.length}`);
console.log(`  📋 Review: ${finalReview?.length}`);
console.log('\n  Applied jobs:');
finalApplied?.forEach(j => {
  const hasProof = j.proof_url ? '🖼️' : '❌';
  const hasResume = j.tailored_resume_url ? '📄' : '❌';
  console.log(`    ${hasProof}${hasResume} [${j.id}] ${j.company} - ${j.title?.substring(0, 40)}`);
});

console.log('\n  Review jobs:');
finalReview?.forEach(j => console.log(`    📋 [${j.id}] ${j.company} - ${j.title?.substring(0, 40)}`));

console.log('\n✅ Migration complete!');
