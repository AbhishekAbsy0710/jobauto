#!/usr/bin/env node
// ============================================
// Migrate SQLite → Supabase
// Copies all jobs, evaluations, and applications
// ============================================
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'db', 'jobauto.db');

// Load .env
import { loadConfig } from '../config.js';
const config = loadConfig();

if (!config.supabaseUrl || !config.supabaseServiceKey) {
  console.error('❌ Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const sqlite = new Database(DB_PATH, { readonly: true });
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

async function migrate() {
  console.log('🔄 Starting SQLite → Supabase migration...\n');

  // 1. Migrate jobs
  const jobs = sqlite.prepare('SELECT * FROM jobs').all();
  console.log(`📦 ${jobs.length} jobs to migrate`);

  const idMap = {}; // old SQLite id → new Supabase id

  for (const job of jobs) {
    let tags = [];
    try { tags = JSON.parse(job.tags || '[]'); } catch {}

    const { data, error } = await supabase.from('jobs').upsert({
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      apply_link: job.apply_link,
      platform: job.platform,
      remote: !!job.remote,
      tags,
      status: job.status || 'new',
      source_id: job.source_id,
      scraped_at: job.scraped_at || new Date().toISOString(),
      updated_at: job.updated_at || new Date().toISOString(),
    }, { onConflict: 'source_id' }).select('id').single();

    if (error) {
      console.error(`  ❌ Job "${job.title}": ${error.message}`);
      continue;
    }
    idMap[job.id] = data.id;
    process.stdout.write('.');
  }
  console.log(`\n  ✅ ${Object.keys(idMap).length} jobs migrated\n`);

  // 2. Migrate evaluations
  const evals = sqlite.prepare('SELECT * FROM evaluations').all();
  console.log(`📊 ${evals.length} evaluations to migrate`);

  const evalIdMap = {};

  for (const ev of evals) {
    const supaJobId = idMap[ev.job_id];
    if (!supaJobId) {
      console.error(`  ⚠️  Eval ${ev.id} → job ${ev.job_id} not found, skipping`);
      continue;
    }

    let matching_skills = [], missing_skills = [], resume_improvements = [];
    let dimension_scores = {}, star_stories = [];
    try { matching_skills = JSON.parse(ev.matching_skills || '[]'); } catch {}
    try { missing_skills = JSON.parse(ev.missing_skills || '[]'); } catch {}
    try { resume_improvements = JSON.parse(ev.resume_improvements || '[]'); } catch {}
    try { dimension_scores = JSON.parse(ev.dimension_scores || '{}'); } catch {}
    try { star_stories = JSON.parse(ev.star_stories || '[]'); } catch {}

    const { data, error } = await supabase.from('evaluations').insert({
      job_id: supaJobId,
      letter_grade: ev.letter_grade,
      weighted_score: ev.weighted_score,
      match_percentage: ev.match_percentage,
      archetype: ev.archetype,
      action: ev.action,
      priority: ev.priority,
      risk_level: ev.risk_level,
      reason: ev.reason,
      matching_skills,
      missing_skills,
      resume_improvements,
      dimension_scores,
      star_stories,
      evaluated_at: ev.evaluated_at || new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.error(`  ❌ Eval ${ev.id}: ${error.message}`);
      continue;
    }
    evalIdMap[ev.id] = data.id;
    process.stdout.write('.');
  }
  console.log(`\n  ✅ ${Object.keys(evalIdMap).length} evaluations migrated\n`);

  // 3. Migrate applications
  const apps = sqlite.prepare('SELECT * FROM applications').all();
  console.log(`✅ ${apps.length} applications to migrate`);

  let appCount = 0;
  for (const app of apps) {
    const supaEvalId = evalIdMap[app.evaluation_id];
    if (!supaEvalId) {
      console.error(`  ⚠️  App ${app.id} → eval ${app.evaluation_id} not found, skipping`);
      continue;
    }

    const { error } = await supabase.from('applications').insert({
      evaluation_id: supaEvalId,
      method: app.method || 'manual',
      status: app.status || 'submitted',
      pdf_path: app.pdf_path,
      applied_at: app.applied_at || new Date().toISOString(),
    });

    if (error) {
      console.error(`  ❌ App ${app.id}: ${error.message}`);
      continue;
    }
    appCount++;
    process.stdout.write('.');
  }
  console.log(`\n  ✅ ${appCount} applications migrated\n`);

  console.log('🎉 Migration complete!');
  console.log(`   Jobs: ${Object.keys(idMap).length}/${jobs.length}`);
  console.log(`   Evals: ${Object.keys(evalIdMap).length}/${evals.length}`);
  console.log(`   Apps: ${appCount}/${apps.length}`);

  sqlite.close();
}

migrate().catch(e => {
  console.error('💥 Migration failed:', e);
  process.exit(1);
});
