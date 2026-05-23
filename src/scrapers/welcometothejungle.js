// Welcome to the Jungle (WTTJ) scraper
// Uses WTTJ's public GraphQL-backed search API
// Major EU tech job platform — especially strong in France and Germany

const QUERIES = [
  { q: 'DevOps Engineer', location: 'Germany' },
  { q: 'Cloud Engineer', location: 'Germany' },
  { q: 'Software Engineer', location: 'Germany' },
  { q: 'Data Engineer', location: 'France' },
  { q: 'Full Stack Developer', location: 'France' },
  { q: 'Platform Engineer', location: 'Netherlands' },
  { q: 'DevOps Engineer', location: 'Switzerland' },
  { q: 'Backend Developer', location: 'Germany' },
  { q: 'AI Engineer', location: 'France' },
  { q: 'SRE', location: 'Germany' },
];

export async function scrapeWTTJ() {
  console.log('🔍 Scraping Welcome to the Jungle (EU)...');
  const jobs = [];
  const seenIds = new Set();

  for (const search of QUERIES) {
    try {
      // WTTJ public search endpoint
      const url = `https://www.welcometothejungle.com/api/v1/organizations?query=${encodeURIComponent(search.q)}&aroundLatLng=&page=1&per_page=20`;
      
      // Alternative: use the public HTML search and extract JSON-LD
      const searchUrl = `https://www.welcometothejungle.com/en/jobs?query=${encodeURIComponent(search.q)}&page=1&aroundQuery=${encodeURIComponent(search.location)}`;
      
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.log(`  ⚠️ WTTJ ${search.q}/${search.location}: ${res.status}`);
        continue;
      }

      const html = await res.text();

      // Extract JSON-LD structured data (JobPosting schema)
      const ldJsonBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      for (const block of ldJsonBlocks) {
        try {
          const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
          const data = JSON.parse(jsonStr);
          const items = Array.isArray(data) ? data : (data.itemListElement || data['@graph'] || [data]);

          for (const item of items) {
            const posting = item.item || item;
            if (posting['@type'] !== 'JobPosting') continue;

            const externalId = `wttj_${Buffer.from(posting.url || posting.title || '').toString('base64').slice(0, 40)}`;
            if (seenIds.has(externalId)) continue;
            seenIds.add(externalId);

            const loc = posting.jobLocation;
            const location = Array.isArray(loc)
              ? loc.map(l => l.address?.addressLocality || '').filter(Boolean).join(', ')
              : (loc?.address?.addressLocality || search.location);

            jobs.push({
              title: posting.title || '',
              company: posting.hiringOrganization?.name || 'Unknown',
              location,
              description: (posting.description || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 5000),
              apply_link: posting.url || searchUrl,
              platform: 'wttj',
              external_id: externalId,
              tags: [search.q],
              posted_at: posting.datePosted || new Date().toISOString(),
              remote: (posting.jobLocationType || '').toLowerCase().includes('remote') ||
                      (posting.title || '').toLowerCase().includes('remote'),
            });
          }
        } catch { /* skip malformed JSON-LD */ }
      }

      // Fallback: parse HTML job cards if no JSON-LD found
      if (ldJsonBlocks.length === 0) {
        const cardRegex = /data-testid="search-results-list-item-wrapper"[\s\S]*?<\/article>/g;
        const cards = html.match(cardRegex) || [];
        for (const card of cards) {
          const title = (card.match(/aria-label="([^"]*?)"/)?.[1] || '').trim();
          const link = (card.match(/href="(\/en\/companies\/[^"]*?\/jobs\/[^"]*?)"/)?.[1] || '').trim();
          const company = (card.match(/data-testid="search-results-list-item-company-name"[^>]*>([^<]*)/)?.[1] || '').trim();

          if (title && link) {
            const fullLink = `https://www.welcometothejungle.com${link}`;
            const externalId = `wttj_${Buffer.from(fullLink).toString('base64').slice(0, 40)}`;
            if (seenIds.has(externalId)) continue;
            seenIds.add(externalId);

            jobs.push({
              title,
              company: company || 'Unknown',
              location: search.location,
              description: `${title} at ${company}`,
              apply_link: fullLink,
              platform: 'wttj',
              external_id: externalId,
              tags: [search.q],
              posted_at: new Date().toISOString(),
            });
          }
        }
      }

      console.log(`  ✅ WTTJ ${search.q}/${search.location}: parsed`);
    } catch (e) {
      console.log(`  ⚠️ WTTJ ${search.q}/${search.location}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`📦 WTTJ total: ${jobs.length} EU jobs`);
  return jobs;
}
