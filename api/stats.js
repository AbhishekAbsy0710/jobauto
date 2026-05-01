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

  const sb = getSupabase();

  const [
    { count: totalJobs },
    { count: evaluated },
    { count: newJobs },
    { count: applied },
    { count: queued },
    { count: archived },
  ] = await Promise.all([
    sb.from('jobs').select('*', { count: 'exact', head: true }),
    sb.from('evaluations').select('*', { count: 'exact', head: true }),
    sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'applied'),
    sb.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['auto_queue', 'manual_queue']),
    sb.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'archived'),
  ]);

  const { data: grades } = await sb.rpc('get_grade_counts').catch(() => ({ data: null }));
  const { data: platforms } = await sb.from('jobs').select('platform').then(r => {
    const map = {};
    (r.data || []).forEach(j => { map[j.platform] = (map[j.platform] || 0) + 1; });
    return { data: Object.entries(map).map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count) };
  });

  // Grade counts
  const { data: gradeRows } = await sb.from('evaluations').select('letter_grade');
  const gradeCounts = {};
  (gradeRows || []).forEach(e => { if (e.letter_grade) gradeCounts[e.letter_grade] = (gradeCounts[e.letter_grade] || 0) + 1; });
  const gradeArr = Object.entries(gradeCounts).map(([letter_grade, count]) => ({ letter_grade, count })).sort((a, b) => a.letter_grade.localeCompare(b.letter_grade));

  // Archetype counts
  const { data: archRows } = await sb.from('evaluations').select('archetype');
  const archCounts = {};
  (archRows || []).forEach(e => { if (e.archetype) archCounts[e.archetype] = (archCounts[e.archetype] || 0) + 1; });
  const archetypes = Object.entries(archCounts).map(([archetype, count]) => ({ archetype, count })).sort((a, b) => b.count - a.count);

  // Avg score
  const { data: scoreRows } = await sb.from('evaluations').select('weighted_score').gt('weighted_score', 0);
  const avgMatch = scoreRows?.length ? Math.round((scoreRows.reduce((s, r) => s + r.weighted_score, 0) / scoreRows.length) * 10) / 10 : 0;

  const highPri = (gradeRows || []).filter(e => e.letter_grade === 'A' || e.letter_grade === 'B').length;

  res.json({
    total_jobs: totalJobs || 0,
    new_jobs: newJobs || 0,
    evaluated: evaluated || 0,
    auto_apply: (queued || 0) + (applied || 0),
    manual_apply: queued || 0,
    ignored: archived || 0,
    applied: applied || 0,
    high_priority: highPri,
    avg_match: avgMatch,
    grades: gradeArr,
    platforms,
    archetypes,
    interviews: 0,
  });
}
