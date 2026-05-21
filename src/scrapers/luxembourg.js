// Luxembourg dedicated job scraper
// Sources:
//  1. Amazon Jobs public JSON API (Luxembourg filter) → direct apply link
//  2. Skyscanner via Greenhouse (board_id: skyscanner) — handled by portals.yml
//  3. jobs.lu RSS feed (public, no auth)
// Note: Skyscanner is scraped via portals.yml Greenhouse section — not duplicated here.

const FILTER_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data', 'backend',
  'platform', 'infrastructure', 'software', 'full stack', 'fullstack',
  'ai', 'machine learning', 'ml', 'site reliability', 'sre', 'analyst'
];

function matchesKeyword(text) {
  const t = (text || '').toLowerCase();
  return FILTER_KEYWORDS.some(k => t.includes(k));
}

// ── 1. Amazon Jobs Luxembourg ─────────────────────────────────────────────────
async function scrapeAmazonLuxembourg() {
  const jobs = [];
  try {
    const url = 'https://www.amazon.jobs/en/search.json?' + new URLSearchParams({
      base_query: 'engineer developer data cloud devops',
      loc_query: 'Luxembourg',
      job_count: '50',
      result_limit: '50',
      country: 'LUX',
    });

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAutoBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log(`  ⚠️  Amazon Jobs Luxembourg: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const allJobs = data.jobs || [];

    for (const j of allJobs) {
      const loc = (j.location || '').toLowerCase();
      if (!loc.includes('luxembourg') && !loc.includes('lux')) continue;
      if (!matchesKeyword(j.title) && !matchesKeyword(j.description_short)) continue;

      jobs.push({
        title: j.title,
        company: j.company_name || 'Amazon',
        location: j.location || 'Luxembourg',
        description: `${j.description_short || ''}\n\nBasic Qualifications:\n${j.basic_qualifications || ''}`.trim(),
        apply_link: `https://www.amazon.jobs${j.job_path || `/en/jobs/${j.id_icims}`}`,
        platform: 'amazon-jobs',
        external_id: `amazon_${j.id_icims}`,
        tags: ['Luxembourg', 'Amazon'],
        posted_at: j.posted_date ? new Date(j.posted_date).toISOString() : new Date().toISOString(),
      });
    }

    console.log(`  🇱🇺 Amazon Jobs Luxembourg: ${jobs.length} matching jobs`);
  } catch (e) {
    console.log(`  ⚠️  Amazon Jobs Luxembourg: ${e.message}`);
  }
  return jobs;
}

// ── 2. Jobs.lu RSS feed ───────────────────────────────────────────────────────
async function scrapeJobsLu() {
  const jobs = [];
  try {
    // jobs.lu has a public RSS for tech roles
    const searches = [
      'https://www.jobs.lu/rss/jobs/?q=engineer&lang=en',
      'https://www.jobs.lu/rss/jobs/?q=developer&lang=en',
      'https://www.jobs.lu/rss/jobs/?q=devops&lang=en',
      'https://www.jobs.lu/rss/jobs/?q=data+engineer&lang=en',
    ];

    for (const url of searches) {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;
      const xml = await res.text();

      // Parse RSS items
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
        const link  = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
        const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                       item.match(/<description>(.*?)<\/description>/))?.[1]?.trim() || '';
        const company = (item.match(/<author>(.*?)<\/author>/) ||
                         item.match(/<dc:creator>(.*?)<\/dc:creator>/))?.[1]?.trim() || 'Unknown';
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';

        if (!title || !link) continue;
        if (!matchesKeyword(title) && !matchesKeyword(desc)) continue;

        jobs.push({
          title,
          company,
          location: 'Luxembourg',
          description: desc.replace(/<[^>]+>/g, '').slice(0, 1500),
          apply_link: link,
          platform: 'jobs.lu',
          external_id: `jobslu_${Buffer.from(link).toString('base64').slice(0, 30)}`,
          tags: ['Luxembourg'],
          posted_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`  🇱🇺 Jobs.lu RSS: ${jobs.length} matching jobs`);
  } catch (e) {
    console.log(`  ⚠️  Jobs.lu: ${e.message}`);
  }

  // dedupe by link
  const seen = new Set();
  return jobs.filter(j => seen.has(j.apply_link) ? false : seen.add(j.apply_link));
}

// ── 3. Moovijob (Luxembourg+Greater Region job board) ─────────────────────────
async function scrapeMoovijob() {
  const jobs = [];
  try {
    // Moovijob API (Luxembourg-specific job board)
    const res = await fetch(
      'https://www.moovijob.com/api/v2/offers?country=LU&category=it&limit=50',
      {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) { console.log(`  ⚠️  Moovijob: ${res.status}`); return []; }

    const data = await res.json();
    const offers = data.offers || data.data || data.results || [];

    for (const j of offers) {
      const title = j.title || j.name || '';
      const desc  = j.description || j.body || '';
      if (!matchesKeyword(title) && !matchesKeyword(desc)) continue;

      jobs.push({
        title,
        company: j.company?.name || j.employer || 'Unknown',
        location: `${j.city || 'Luxembourg'}, Luxembourg`,
        description: desc.replace(/<[^>]+>/g, '').slice(0, 1500),
        apply_link: j.url || j.apply_url || `https://www.moovijob.com/offres/${j.id || j.slug}`,
        platform: 'moovijob',
        external_id: `moovijob_${j.id || j.slug || Buffer.from(title).toString('base64').slice(0,20)}`,
        tags: ['Luxembourg'],
        posted_at: j.published_at || j.created_at || new Date().toISOString(),
      });
    }
    console.log(`  🇱🇺 Moovijob: ${jobs.length} matching jobs`);
  } catch (e) {
    console.log(`  ⚠️  Moovijob: ${e.message}`);
  }
  return jobs;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function scrapeLuxembourg() {
  console.log('🇱🇺 Scraping Luxembourg-specific job sources...');
  const [amazon, jobslu, moovi] = await Promise.allSettled([
    scrapeAmazonLuxembourg(),
    scrapeJobsLu(),
    scrapeMoovijob(),
  ]);

  const all = [
    ...(amazon.status === 'fulfilled' ? amazon.value : []),
    ...(jobslu.status === 'fulfilled' ? jobslu.value : []),
    ...(moovi.status === 'fulfilled'  ? moovi.value  : []),
  ];

  console.log(`📦 Luxembourg total: ${all.length} jobs`);
  return all;
}
