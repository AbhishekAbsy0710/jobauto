// ============================================
// Supabase Database Client
// ============================================
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config.js';

let _supabase = null;

export function getSupabase() {
  if (_supabase) return _supabase;
  const config = loadConfig();
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    return null; // Fall back to SQLite
  }
  _supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

export function useSupabase() {
  return !!getSupabase();
}

// ============================================
// JOBS
// ============================================
export async function upsertJob(job) {
  const sb = getSupabase();
  const { data, error } = await sb.from('jobs').upsert({
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    apply_link: job.apply_link,
    platform: job.platform,
    remote: job.remote || false,
    tags: job.tags || [],
    status: job.status || 'new',
    source_id: job.source_id,
  }, { onConflict: 'source_id' }).select().single();
  if (error) throw new Error(`upsertJob: ${error.message}`);
  return data;
}

export async function getJobs({ status, search, limit = 200 } = {}) {
  const sb = getSupabase();
  let query = sb.from('jobs').select(`
    *,
    evaluations (
      id, letter_grade, weighted_score, match_percentage,
      archetype, action, priority, risk_level, reason,
      matching_skills, missing_skills, resume_improvements,
      dimension_scores, star_stories, evaluated_at
    )
  `).order('scraped_at', { ascending: false }).limit(limit);

  if (status) query = query.eq('status', status);
  if (search) query = query.or(`title.ilike.%${search}%,company.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) throw new Error(`getJobs: ${error.message}`);

  // Flatten evaluation into job (match SQLite format)
  return data.map(j => {
    const ev = j.evaluations?.[0] || null;
    const flat = { ...j };
    delete flat.evaluations;
    if (ev) {
      flat.letter_grade = ev.letter_grade;
      flat.weighted_score = ev.weighted_score;
      flat.match_percentage = ev.match_percentage;
      flat.archetype = ev.archetype;
      flat.action = ev.action;
      flat.priority = ev.priority;
      flat.risk_level = ev.risk_level;
      flat.reason = ev.reason;
      flat.matching_skills = ev.matching_skills;
      flat.missing_skills = ev.missing_skills;
      flat.resume_improvements = ev.resume_improvements;
      flat.dimension_scores = ev.dimension_scores;
      flat.star_stories = ev.star_stories;
      flat.evaluated_at = ev.evaluated_at;
    }
    return flat;
  });
}

export async function getJobById(id) {
  const sb = getSupabase();
  const { data: job, error } = await sb.from('jobs').select('*').eq('id', id).single();
  if (error) return null;

  const { data: ev } = await sb.from('evaluations')
    .select('*')
    .eq('job_id', id)
    .order('evaluated_at', { ascending: false })
    .limit(1)
    .single();

  return { ...job, evaluation: ev || null };
}

export async function updateJobStatus(id, status) {
  const sb = getSupabase();
  const { error } = await sb.from('jobs').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`updateJobStatus: ${error.message}`);
}

export async function getUnevaluatedJobs(limit = 50) {
  const sb = getSupabase();
  const { data, error } = await sb.from('jobs')
    .select('*, evaluations(id)')
    .is('evaluations', null)
    .in('status', ['new'])
    .order('scraped_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getUnevaluatedJobs: ${error.message}`);
  return data.filter(j => !j.evaluations || j.evaluations.length === 0).map(j => {
    delete j.evaluations;
    return j;
  });
}

// ============================================
// EVALUATIONS
// ============================================
export async function insertEvaluation(jobId, evaluation) {
  const sb = getSupabase();
  const { data, error } = await sb.from('evaluations').insert({
    job_id: jobId,
    letter_grade: evaluation.letter_grade,
    weighted_score: evaluation.weighted_score,
    match_percentage: evaluation.match_percentage,
    archetype: evaluation.archetype,
    action: evaluation.action,
    priority: evaluation.priority,
    risk_level: evaluation.risk_level,
    reason: evaluation.reason,
    matching_skills: evaluation.matching_skills || [],
    missing_skills: evaluation.missing_skills || [],
    resume_improvements: evaluation.resume_improvements || [],
    dimension_scores: evaluation.dimension_scores || {},
    star_stories: evaluation.star_stories || [],
  }).select().single();
  if (error) throw new Error(`insertEvaluation: ${error.message}`);
  return data;
}

// ============================================
// APPLICATIONS
// ============================================
export async function insertApplication(evalId, method, pdfPath) {
  const sb = getSupabase();
  const { data, error } = await sb.from('applications').insert({
    evaluation_id: evalId,
    method: method || 'manual',
    pdf_path: pdfPath || null,
  }).select().single();
  if (error) throw new Error(`insertApplication: ${error.message}`);
  return data;
}

export async function getApplications() {
  const sb = getSupabase();
  const { data, error } = await sb.from('applications')
    .select(`
      id, method, status, pdf_path, applied_at,
      evaluations!inner (
        id, letter_grade, weighted_score, job_id,
        jobs!inner (
          title, company, location, platform, apply_link
        )
      )
    `)
    .order('applied_at', { ascending: false });

  if (error) throw new Error(`getApplications: ${error.message}`);

  // Flatten to match existing API format
  return data.map(a => ({
    app_id: a.id,
    method: a.method,
    app_status: a.status,
    pdf_path: a.pdf_path,
    applied_at: a.applied_at,
    title: a.evaluations?.jobs?.title,
    company: a.evaluations?.jobs?.company,
    location: a.evaluations?.jobs?.location,
    platform: a.evaluations?.jobs?.platform,
    apply_link: a.evaluations?.jobs?.apply_link,
    letter_grade: a.evaluations?.letter_grade,
    weighted_score: a.evaluations?.weighted_score,
  }));
}

// ============================================
// STATS
// ============================================
export async function getStats() {
  const sb = getSupabase();

  const { count: totalJobs } = await sb.from('jobs').select('*', { count: 'exact', head: true });
  const { count: applied } = await sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'applied');
  const { count: queued } = await sb.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['auto_queue', 'manual_queue']);
  const { count: evaluated } = await sb.from('evaluations').select('*', { count: 'exact', head: true });

  const { data: gradeA } = await sb.from('evaluations').select('id', { count: 'exact', head: true }).eq('letter_grade', 'A');
  const { data: gradeB } = await sb.from('evaluations').select('id', { count: 'exact', head: true }).eq('letter_grade', 'B');

  return {
    total_jobs: totalJobs || 0,
    evaluated: evaluated || 0,
    applied: applied || 0,
    queued: queued || 0,
    grade_a: gradeA?.length || 0,
    grade_b: gradeB?.length || 0,
  };
}
