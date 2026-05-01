// Vercel Cron: /api/cron/scrape — runs every 6 hours
// Scrapes EU job boards and saves to Supabase
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

// Lightweight scraper for Vercel (no Playwright, just RSS/HTML fetch)
async function scrapeArbeitnow() {
  const jobs = [];
  const keywords = (process.env.SEARCH_KEYWORDS || 'DevOps,Cloud,Full Stack,Data Engineer,AI Engineer,Data Analyst,Data Scientist').split(',');

  for (const keyword of keywords) {
    try {
      const url = `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(keyword.trim())}&location=europe`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of (data.data || []).slice(0, 20)) {
        jobs.push({
          title: j.title,
          company: j.company_name,
          location: j.location || 'Remote',
          description: (j.description || '').replace(/<[^>]*>/g, ' ').slice(0, 3000),
          apply_link: j.url,
          platform: 'ArbeitNow',
          remote: j.remote || false,
          tags: j.tags || [],
          source_id: `arbeitnow_${j.slug || j.title?.replace(/\s/g, '_')}`,
        });
      }
    } catch (e) {
      console.error(`Scrape error (${keyword}):`, e.message);
    }
  }
  return jobs;
}

async function scrapeRemotive() {
  const jobs = [];
  try {
    const res = await fetch('https://remotive.com/api/remote-jobs?limit=30', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return jobs;
    const data = await res.json();
    for (const j of (data.jobs || []).slice(0, 30)) {
      jobs.push({
        title: j.title,
        company: j.company_name,
        location: j.candidate_required_location || 'Remote',
        description: (j.description || '').replace(/<[^>]*>/g, ' ').slice(0, 3000),
        apply_link: j.url,
        platform: 'Remotive',
        remote: true,
        tags: [j.category].filter(Boolean),
        source_id: `remotive_${j.id}`,
      });
    }
  } catch (e) {
    console.error('Remotive error:', e.message);
  }
  return jobs;
}

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    // Allow in dev, check in prod
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  console.log('🔄 Cron scrape starting...');
  const sb = getSupabase();

  const [arbeitnow, remotive] = await Promise.all([
    scrapeArbeitnow(),
    scrapeRemotive(),
  ]);

  const allJobs = [...arbeitnow, ...remotive];
  console.log(`📦 Found ${allJobs.length} jobs (${arbeitnow.length} ArbeitNow, ${remotive.length} Remotive)`);

  let inserted = 0;
  let skipped = 0;

  for (const job of allJobs) {
    const { error } = await sb.from('jobs').upsert({
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      apply_link: job.apply_link,
      platform: job.platform,
      remote: job.remote,
      tags: job.tags,
      source_id: job.source_id,
    }, { onConflict: 'source_id', ignoreDuplicates: true });

    if (error) { skipped++; } else { inserted++; }
  }

  const result = { scraped: allJobs.length, inserted, skipped, timestamp: new Date().toISOString() };
  console.log('✅ Scrape complete:', result);

  // Send Discord notification
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'JobAuto',
        embeds: [{
          title: '🔄 Scrape Complete',
          color: 0x4da6ff,
          description: `Found **${allJobs.length}** jobs, **${inserted}** new`,
          timestamp: new Date().toISOString(),
        }],
      }),
    }).catch(() => {});
  }

  res.json(result);
}
