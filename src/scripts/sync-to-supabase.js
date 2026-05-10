#!/usr/bin/env node
/**
 * Sync local SQLite data → Supabase
 * Pushes evaluations + applications so the Vercel dashboard shows the same data.
 */
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// Load .env
try {
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const DB_PATH = join(ROOT, 'db', 'jobauto.db');
const db = new Database(DB_PATH, { readonly: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

async function syncJobs() {
  const jobs = db.prepare('SELECT * FROM jobs').all();
  console.log(`📦 Syncing ${jobs.length} jobs...`);

  let upserted = 0, errors = 0;
  // Batch in groups of 50
  for (let i = 0; i < jobs.length; i += 50) {
    const batch = jobs.slice(i, i + 50).map(j => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      platform: j.platform,
      apply_link: j.apply_link,
      description: j.description,
      tags: typeof j.tags === 'string' ? JSON.parse(j.tags || '[]') : (j.tags || []),
      remote: j.remote,
      status: j.status,
      scraped_at: j.scraped_at,
    }));

    const { error } = await supabase.from('jobs').upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.error(`  ❌ Jobs batch ${i}: ${error.message}`);
      errors++;
    } else {
      upserted += batch.length;
    }
  }
  console.log(`  ✅ Jobs: ${upserted} upserted, ${errors} errors`);
}

async function syncEvaluations() {
  const evals = db.prepare('SELECT * FROM evaluations').all();
  console.log(`📦 Syncing ${evals.length} evaluations...`);

  let upserted = 0, errors = 0;
  for (let i = 0; i < evals.length; i += 50) {
    const batch = evals.slice(i, i + 50).map(e => ({
      id: e.id,
      job_id: e.job_id,
      letter_grade: e.letter_grade,
      weighted_score: e.weighted_score,
      match_percentage: e.match_percentage,
      archetype: e.archetype,
      action: e.action,
      priority: e.priority,
      risk_level: e.risk_level,
      reason: e.reason,
      matching_skills: typeof e.matching_skills === 'string' ? JSON.parse(e.matching_skills || '[]') : (e.matching_skills || []),
      missing_skills: typeof e.missing_skills === 'string' ? JSON.parse(e.missing_skills || '[]') : (e.missing_skills || []),
      resume_improvements: typeof e.resume_improvements === 'string' ? JSON.parse(e.resume_improvements || '[]') : (e.resume_improvements || []),
      dimension_scores: typeof e.dimension_scores === 'string' ? JSON.parse(e.dimension_scores || '{}') : (e.dimension_scores || {}),
      star_stories: typeof e.star_stories === 'string' ? JSON.parse(e.star_stories || '[]') : (e.star_stories || []),
      evaluated_at: e.evaluated_at,
    }));

    const { error } = await supabase.from('evaluations').upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.error(`  ❌ Evaluations batch ${i}: ${error.message}`);
      errors++;
    } else {
      upserted += batch.length;
    }
  }
  console.log(`  ✅ Evaluations: ${upserted} upserted, ${errors} errors`);
}

async function syncApplications() {
  const apps = db.prepare('SELECT * FROM applications').all();
  console.log(`📦 Syncing ${apps.length} applications...`);

  let upserted = 0, errors = 0;
  for (const app of apps) {
    const { error } = await supabase.from('applications').upsert({
      id: app.id,
      evaluation_id: app.evaluation_id,
      method: app.method,
      status: app.status,
      pdf_path: app.pdf_path,
      applied_at: app.applied_at,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (error) {
      console.error(`  ❌ App ${app.id}: ${error.message}`);
      errors++;
    } else {
      upserted++;
    }
  }
  console.log(`  ✅ Applications: ${upserted} upserted, ${errors} errors`);
}

async function main() {
  console.log('🔄 Syncing local SQLite → Supabase...\n');

  try {
    await syncJobs();
    await syncEvaluations();
    await syncApplications();
    console.log('\n✅ Sync complete!');
  } catch (e) {
    console.error('❌ Sync failed:', e.message);
    process.exit(1);
  }

  db.close();
}

main();
