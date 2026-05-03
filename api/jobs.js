// Vercel API Route: /api/jobs
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sb = getSupabase();
  const { limit = 200, grade, search, id } = req.query;

  // Single job by ID
  if (id) {
    const jobId = parseInt(id);
    const { data: job, error } = await sb.from('jobs').select('*').eq('id', jobId).single();
    if (error || !job) return res.status(404).json({ error: 'Not found' });

    const { data: ev } = await sb.from('evaluations')
      .select('*, applications(*)')
      .eq('job_id', jobId)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return res.json({ ...job, evaluation: ev || null });
  }

  // Jobs list with evaluations
  let query = sb.from('jobs').select(`
    *,
    evaluations (
      letter_grade, weighted_score, match_percentage,
      archetype, action, priority, risk_level, reason,
      matching_skills, missing_skills, resume_improvements,
      dimension_scores, star_stories, evaluated_at,
      applications (*)
    )
  `).limit(parseInt(limit));

  if (grade) {
    // Need to filter by evaluation grade - use inner join approach
    const { data: evalJobs } = await sb.from('evaluations')
      .select('job_id')
      .eq('letter_grade', grade);
    const jobIds = (evalJobs || []).map(e => e.job_id);
    if (jobIds.length) query = query.in('id', jobIds);
    else return res.json([]);
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,company.ilike.%${search}%`);
  }

  const { data: jobs, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Flatten evaluations to match existing frontend format
  const flat = (jobs || []).map(j => {
    const ev = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
    const result = { ...j };
    delete result.evaluations;
    if (ev) {
      Object.assign(result, {
        letter_grade: ev.letter_grade,
        weighted_score: ev.weighted_score,
        match_percentage: ev.match_percentage,
        archetype: ev.archetype,
        action: ev.action,
        priority: ev.priority,
        risk_level: ev.risk_level,
        reason: ev.reason,
        matching_skills: ev.matching_skills || [],
        missing_skills: ev.missing_skills || [],
        resume_improvements: ev.resume_improvements || [],
        dimension_scores: ev.dimension_scores || {},
        star_stories: ev.star_stories || [],
        evaluated_at: ev.evaluated_at,
        applications: ev.applications || []
      });
    }
    return result;
  });

  // Sort by weighted_score DESC
  flat.sort((a, b) => (b.weighted_score || 0) - (a.weighted_score || 0));

  res.json(flat);
}
