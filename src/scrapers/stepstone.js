// StepStone.de scraper — German/EU tech jobs
// Uses StepStone's public search JSON API

const QUERIES = [
  'DevOps Engineer', 'Cloud Engineer', 'Full Stack Developer',
  'Data Engineer', 'Platform Engineer', 'Site Reliability Engineer',
  'Software Engineer', 'Infrastructure Engineer', 'AI Engineer',
  'Backend Developer',
];

export async function scrapeStepStone() {
  console.log('🔍 Scraping StepStone.de...');
  const jobs = [];

  for (const query of QUERIES) {
    try {
      const url = `https://www.stepstone.de/work/${encodeURIComponent(query.replace(/ /g, '-').toLowerCase())}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`  ⚠️ StepStone ${query}: ${res.status}`); continue; }
      const html = await res.text();

      // Extract job data from script tags or structured data
      const ldJsonMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      for (const match of ldJsonMatches) {
        try {
          const jsonStr = match.replace(/<script type="application\/ld\+json">/, '').replace(/<\/script>/, '');
          const data = JSON.parse(jsonStr);
          const items = data['@type'] === 'ItemList' ? (data.itemListElement || []) : [data];

          for (const item of items) {
            const posting = item.item || item;
            if (posting['@type'] !== 'JobPosting') continue;

            jobs.push({
              title: posting.title || '',
              company: posting.hiringOrganization?.name || 'Unknown',
              location: posting.jobLocation?.address?.addressLocality || posting.jobLocation?.name || 'Germany',
              description: (posting.description || '').replace(/<[^>]*>/g, '').slice(0, 2000),
              apply_link: posting.url || url,
              platform: 'stepstone',
              external_id: `stepstone_${Buffer.from(posting.url || posting.title || '').toString('base64').slice(0, 40)}`,
              tags: [query],
              posted_at: posting.datePosted || new Date().toISOString(),
            });
          }
        } catch {}
      }

      console.log(`  ✅ StepStone "${query}": found listings`);
    } catch (e) {
      console.log(`  ⚠️ StepStone ${query}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000)); // rate limit
  }

  console.log(`📦 StepStone total: ${jobs.length} jobs`);
  return jobs;
}
