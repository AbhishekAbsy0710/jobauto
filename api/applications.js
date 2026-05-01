// Vercel API Route: /api/applications
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

  const { data, error } = await sb.from('applications')
    .select(`
      id, method, status, pdf_path, applied_at,
      evaluations!inner (
        letter_grade, weighted_score, matching_skills, resume_improvements,
        jobs!inner (
          title, company, location, platform, apply_link
        )
      )
    `)
    .order('applied_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Flatten to match existing frontend format
  const apps = (data || []).map(a => ({
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
    matching_skills: a.evaluations?.matching_skills || [],
    resume_improvements: a.evaluations?.resume_improvements || [],
  }));

  res.json(apps);
}
