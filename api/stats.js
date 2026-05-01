// Vercel API Route: /api/stats
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const sb = getSupabase();

    const [totalRes, evalRes, newRes, appliedRes, queueRes, archivedRes] = await Promise.all([
      sb.from('jobs').select('*', { count: 'exact', head: true }),
      sb.from('evaluations').select('*', { count: 'exact', head: true }),
      sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'new'),
      sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'applied'),
      sb.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['auto_queue', 'manual_queue']),
      sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'archived'),
    ]);

    const totalJobs = totalRes.count || 0;
    const evaluated = evalRes.count || 0;
    const newJobs = newRes.count || 0;
    const applied = appliedRes.count || 0;
    const queued = queueRes.count || 0;
    const archived = archivedRes.count || 0;

    // Platforms
    const { data: platRows } = await sb.from('jobs').select('platform');
    const platMap = {};
    (platRows || []).forEach(j => { platMap[j.platform] = (platMap[j.platform] || 0) + 1; });
    const platforms = Object.entries(platMap).map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count);

    // Grade counts
    const { data: gradeRows } = await sb.from('evaluations').select('letter_grade');
    const gradeCounts = {};
    (gradeRows || []).forEach(e => { if (e.letter_grade) gradeCounts[e.letter_grade] = (gradeCounts[e.letter_grade] || 0) + 1; });
    const grades = Object.entries(gradeCounts).map(([letter_grade, count]) => ({ letter_grade, count })).sort((a, b) => a.letter_grade.localeCompare(b.letter_grade));

    // Archetypes
    const { data: archRows } = await sb.from('evaluations').select('archetype');
    const archCounts = {};
    (archRows || []).forEach(e => { if (e.archetype) archCounts[e.archetype] = (archCounts[e.archetype] || 0) + 1; });
    const archetypes = Object.entries(archCounts).map(([archetype, count]) => ({ archetype, count })).sort((a, b) => b.count - a.count);

    // Avg score
    const { data: scoreRows } = await sb.from('evaluations').select('weighted_score').gt('weighted_score', 0);
    const avgMatch = scoreRows?.length ? Math.round((scoreRows.reduce((s, r) => s + r.weighted_score, 0) / scoreRows.length) * 10) / 10 : 0;

    const highPri = (gradeRows || []).filter(e => e.letter_grade === 'A' || e.letter_grade === 'B').length;

    res.json({
      total_jobs: totalJobs,
      new_jobs: newJobs,
      evaluated,
      auto_apply: queued + applied,
      manual_apply: queued,
      ignored: archived,
      applied,
      high_priority: highPri,
      avg_match: avgMatch,
      grades,
      platforms,
      archetypes,
      interviews: 0,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
}
