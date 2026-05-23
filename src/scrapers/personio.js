// Personio career page scraper
// Uses Personio's public XML job feed: {company}.jobs.personio.de/xml
// No authentication required — fully public

const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data', 'platform',
  'infrastructure', 'backend', 'frontend', 'fullstack', 'full stack',
  'sre', 'site reliability', 'machine learning', 'ml ', 'ai ',
  'software', 'security engineer', 'solutions engineer', 'systems engineer',
  'python', 'typescript', 'golang', 'kubernetes', 'mlops', 'analytics',
];

export async function scrapePersonio(companies = []) {
  console.log(`🔍 Scraping Personio (${companies.length} companies)...`);
  const allJobs = [];

  for (const company of companies) {
    const { subdomain, name } = company;
    try {
      // Personio public XML job feed
      const feedUrl = `https://${subdomain}.jobs.personio.de/xml`;
      const resp = await fetch(feedUrl, {
        headers: {
          'Accept': 'application/xml, text/xml',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Personio ${name}: HTTP ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      // Parse XML positions
      const positions = xml.match(/<position>([\s\S]*?)<\/position>/g) || [];
      let matched = 0;

      for (const pos of positions) {
        const posName = (pos.match(/<name>(.*?)<\/name>/)?.[1] || '').trim();
        const titleLower = posName.toLowerCase();
        const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
        if (!isTech) continue;

        const posId = (pos.match(/<id>(.*?)<\/id>/)?.[1] || '').trim();
        const dept = (pos.match(/<department>(.*?)<\/department>/)?.[1] || '').trim();
        const office = (pos.match(/<office>(.*?)<\/office>/)?.[1] || '').trim();
        const schedule = (pos.match(/<schedule>(.*?)<\/schedule>/)?.[1] || '').trim();
        const desc = (pos.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/)?.[1] || '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 5000);

        const applyUrl = `https://${subdomain}.jobs.personio.de/job/${posId}`;

        allJobs.push({
          external_id: `personio_${subdomain}_${posId}`,
          title: posName,
          company: name,
          platform: 'personio',
          apply_link: applyUrl,
          apply_type: 'external',
          description: desc || posName,
          location: office || 'Not specified',
          tags: [dept, schedule].filter(Boolean),
          remote: titleLower.includes('remote') || office.toLowerCase().includes('remote'),
        });
        matched++;
      }

      if (matched > 0) {
        console.log(`  ✅ Personio ${name}: ${matched} tech roles`);
      }
    } catch (err) {
      console.log(`  ⚠️ Personio ${name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  ✅ Personio total: ${allJobs.length} jobs`);
  return allJobs;
}
