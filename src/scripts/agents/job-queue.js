/**
 * agents/job-queue.js — Job Queue Agent
 * 
 * Fetches jobs from Supabase, applies filters, scoring, diversity caps.
 * Pure data logic — no browser interaction.
 * 
 * Exports:
 *   - getJobQueue(supabase, opts) → Job[]
 */

import {
  TARGET_KEYWORDS, SKIP_KEYWORDS,
  MAX_JOBS_PER_RUN, MAX_PREFILTER_PER_COMPANY, PAGE_LOAD_BLOCKED
} from './constants.js';

/**
 * Fetch and filter the job queue from Supabase.
 * 
 * @param {object} supabase - Supabase client
 * @param {object} opts
 * @param {boolean} opts.isLocal - Running locally (include Greenhouse)
 * @param {string} opts.testJobId - If set, only fetch this job
 * @returns {object[]} Filtered, scored, capped job array
 */
export async function getJobQueue(supabase, opts = {}) {
  const { isLocal = false, testJobId = null } = opts;

  // 30-day window to include full backlog
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let query;
  if (testJobId) {
    console.log(`🧪 TEST MODE — running only job ID ${testJobId}`);
    query = supabase
      .from('jobs')
      .select('*, evaluations(id, letter_grade, weighted_score)')
      .eq('id', testJobId);
  } else if (isLocal) {
    // LOCAL MODE: pull BOTH auto_queue AND manual_queue (home IP isn't blocked)
    console.log(`  🏠 LOCAL_RUN mode — pulling auto_queue + manual_queue (home IP not blocked)`);
    query = supabase
      .from('jobs')
      .select('*, evaluations(id, letter_grade, weighted_score)')
      .in('status', ['auto_queue', 'manual_queue'])
      .gte('scraped_at', thirtyDaysAgo)
      .order('scraped_at', { ascending: false })
      .limit(500);
  } else {
    // GHA MODE: only auto_queue, exclude Greenhouse (Cloudflare blocks datacenter IPs)
    query = supabase
      .from('jobs')
      .select('*, evaluations(id, letter_grade, weighted_score)')
      .eq('status', 'auto_queue')
      .gte('scraped_at', thirtyDaysAgo);
    query = query.not('apply_link', 'ilike', '%greenhouse%');
    query = query.order('scraped_at', { ascending: false }).limit(200);
  }

  const { data: rawJobs, error } = await query;

  if (error || !rawJobs || rawJobs.length === 0) {
    console.log('💭 No jobs in the apply queue (all caught up)');
    return [];
  }

  // Enrich with evaluation data
  let jobs = rawJobs.map(j => {
    const e = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
    return { ...j, eval_id: e?.id, grade: e?.letter_grade, score: e?.weighted_score || 0 };
  }).sort((a, b) => (b.score || 0) - (a.score || 0)); // best-scored first

  // On GHA: move Greenhouse jobs to manual_queue
  if (!isLocal) {
    const greenhouseJobs = jobs.filter(j => (j.apply_link || '').includes('greenhouse'));
    if (greenhouseJobs.length > 0) {
      console.log(`  ⚠️  Skipping ${greenhouseJobs.length} Greenhouse jobs (Cloudflare blocks GHA IPs) — moved to manual_queue`);
      for (const gj of greenhouseJobs) {
        try {
          await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', gj.id);
        } catch (e) {}
      }
    }
    jobs = jobs.filter(j => !(j.apply_link || '').includes('greenhouse'));
  }

  // Pre-filter: remove known-broken URLs (bad scraper data, login portals, etc.)
  const BAD_URL_PATTERNS = [
    'community.workday.com',            // Workday community, not jobs
    '/login',                           // Login pages (no direct apply)
    '/sign-in',                         // Sign-in pages
    'linkedin.com/jobs/view',           // LinkedIn job views (requires auth)
  ];
  const preFilterLen = jobs.length;
  jobs = jobs.filter(j => {
    const link = (j.apply_link || '').toLowerCase();
    if (!link || link === '#' || (!link.startsWith('http://') && !link.startsWith('https://'))) {
      console.log(`  ⏭️ Skipping invalid URL: ${link.substring(0, 50)} (${j.company})`);
      return false;
    }
    const isBad = BAD_URL_PATTERNS.some(p => link.includes(p));
    if (isBad) {
      console.log(`  ⏭️ Skipping bad URL: ${link.substring(0, 60)}... (${j.company})`);
    }
    return !isBad;
  });
  if (jobs.length < preFilterLen) {
    console.log(`  🧹 Filtered ${preFilterLen - jobs.length} bad URLs`);
  }

  // Pre-filter: cap per company so one company can't dominate
  const prefilterCounts = {};
  jobs = jobs.filter(j => {
    const key = (j.company || '').toLowerCase().replace(/[^a-z]/g, '');
    prefilterCounts[key] = (prefilterCounts[key] || 0) + 1;
    return prefilterCounts[key] <= MAX_PREFILTER_PER_COMPANY;
  });

  // Cap total jobs
  if (jobs.length > MAX_JOBS_PER_RUN) {
    console.log(`  📊 ${jobs.length} jobs queued (after company cap) — capping to top ${MAX_JOBS_PER_RUN} by score`);
    jobs = jobs.slice(0, MAX_JOBS_PER_RUN);
  } else {
    console.log(`  📊 ${jobs.length} jobs queued (max ${MAX_PREFILTER_PER_COMPANY}/company diversity applied)`);
  }

  return jobs;
}

/**
 * Check if a job should be skipped based on title keywords.
 * 
 * @param {object} job - Job object
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipJob(job) {
  const titleLower = (job.title || '').toLowerCase();
  
  // Hard-skip non-IT roles
  const isExcluded = SKIP_KEYWORDS.some(kw => titleLower.includes(kw));
  if (isExcluded) {
    return { skip: true, reason: `blocked keyword: "${job.title}"` };
  }

  // Check for IT relevance
  const IT_ARCHETYPES = ['devops', 'cloud', 'data', 'ai', 'fullstack', 'DevOps', 'Cloud', 'Data', 'AI', 'FullStack'];
  const isRelevant = TARGET_KEYWORDS.some(kw => titleLower.includes(kw))
                  || IT_ARCHETYPES.includes(job.archetype);
  if (!isRelevant) {
    return { skip: true, reason: `no IT keyword match: "${job.title}"` };
  }

  // Check blocked companies
  const companyLower = (job.company || '').toLowerCase();
  if (PAGE_LOAD_BLOCKED.some(b => companyLower.includes(b))) {
    return { skip: true, reason: `blocked company: "${job.company}"` };
  }

  return { skip: false, reason: '' };
}
