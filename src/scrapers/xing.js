// Xing (DACH region) scraper
// Uses Xing's public job search

const QUERIES = [
  'DevOps Engineer', 'Cloud Engineer', 'Full Stack Developer',
  'Data Engineer', 'Platform Engineer', 'Software Engineer',
  'Site Reliability Engineer', 'AI Engineer',
];

export async function scrapeXing() {
  console.log('🔍 Scraping Xing (DACH)...');
  const jobs = [];

  for (const query of QUERIES) {
    try {
      const url = `https://www.xing.com/jobs/search?keywords=${encodeURIComponent(query)}&location=Deutschland&page=1`;

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`  ⚠️ Xing ${query}: ${res.status}`); continue; }
      const html = await res.text();

      // Extract structured data from ld+json
      const ldJson = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      for (const match of ldJson) {
        try {
          const data = JSON.parse(match.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
          const items = Array.isArray(data) ? data : (data.itemListElement || [data]);
          for (const item of items) {
            const posting = item.item || item;
            if (posting['@type'] !== 'JobPosting') continue;
            jobs.push({
              title: posting.title || '',
              company: posting.hiringOrganization?.name || 'Unknown',
              location: posting.jobLocation?.address?.addressLocality || 'Germany',
              description: (posting.description || '').replace(/<[^>]*>/g, '').slice(0, 2000),
              apply_link: posting.url || `https://www.xing.com/jobs/search?keywords=${encodeURIComponent(query)}`,
              platform: 'xing',
              external_id: `xing_${Buffer.from(posting.url || posting.title || '').toString('base64').slice(0, 40)}`,
              tags: [query],
              posted_at: posting.datePosted || new Date().toISOString(),
            });
          }
        } catch {}
      }
      console.log(`  ✅ Xing "${query}": parsed`);
    } catch (e) {
      console.log(`  ⚠️ Xing ${query}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`📦 Xing total: ${jobs.length} DACH jobs`);
  return jobs;
}
