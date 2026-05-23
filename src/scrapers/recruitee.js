// Recruitee career page scraper
// Uses Recruitee's public API: {company}.recruitee.com/api/offers
// No authentication required — fully public

const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data', 'platform',
  'infrastructure', 'backend', 'frontend', 'fullstack', 'full stack',
  'sre', 'site reliability', 'machine learning', 'ml ', 'ai ',
  'software', 'security engineer', 'solutions engineer', 'systems engineer',
  'python', 'typescript', 'golang', 'kubernetes', 'mlops', 'analytics',
];

export async function scrapeRecruitee(companies = []) {
  console.log(`🔍 Scraping Recruitee (${companies.length} companies)...`);
  const allJobs = [];

  for (const company of companies) {
    const { subdomain, name } = company;
    try {
      const apiUrl = `https://${subdomain}.recruitee.com/api/offers`;
      const resp = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Recruitee ${name}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const offers = data.offers || [];
      let matched = 0;

      for (const offer of offers) {
        if (offer.status !== 'published') continue;

        const titleLower = (offer.title || '').toLowerCase();
        const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
        if (!isTech) continue;

        const description = (offer.description || '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 5000);

        const location = offer.location || offer.city || 'Not specified';
        const applyUrl = `https://${subdomain}.recruitee.com/o/${offer.slug}`;

        allJobs.push({
          external_id: `recruitee_${subdomain}_${offer.id}`,
          title: offer.title || 'Unknown',
          company: name,
          platform: 'recruitee',
          apply_link: applyUrl,
          apply_type: 'external',
          description: description || offer.title,
          location,
          tags: [offer.department, offer.category?.name].filter(Boolean),
          remote: offer.remote || titleLower.includes('remote') || location.toLowerCase().includes('remote'),
          posted_at: offer.created_at || new Date().toISOString(),
        });
        matched++;
      }

      if (matched > 0) {
        console.log(`  ✅ Recruitee ${name}: ${matched} tech roles`);
      }
    } catch (err) {
      console.log(`  ⚠️ Recruitee ${name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  ✅ Recruitee total: ${allJobs.length} jobs`);
  return allJobs;
}
