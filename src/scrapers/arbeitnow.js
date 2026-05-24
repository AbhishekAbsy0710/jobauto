// Uses native fetch (Node 18+)

const BASE_URL = 'https://www.arbeitnow.com/api/job-board-api';

export async function scrapeArbeitnow(keywords = [], locations = []) {
  const allJobs = [];

  try {
    // Arbeitnow doesn't support keyword filtering via API params — we fetch all and filter locally
    let page = 1;
    const maxPages = 3;

    while (page <= maxPages) {
      const url = `${BASE_URL}?page=${page}`;
      console.log(`  🇪🇺 Arbeitnow: Fetching page ${page}...`);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        console.log(`  ⚠️ Arbeitnow returned ${response.status}`);
        break;
      }

      const data = await response.json();
      const jobs = data.data || [];

      if (jobs.length === 0) break;

      // Broaden keywords: "DevOps Engineer" → ["devops", "engineer"] + common tech terms
      const TECH_TERMS = ['devops', 'cloud', 'fullstack', 'full-stack', 'full stack', 'backend', 'data engineer',
        'sre', 'platform engineer', 'infrastructure', 'ml engineer', 'ai engineer', 'machine learning',
        'site reliability', 'kubernetes', 'terraform', 'aws', 'azure', 'gcp', 'software engineer'];
      const expandedKeywords = new Set(TECH_TERMS);
      for (const kw of keywords) {
        expandedKeywords.add(kw.toLowerCase());
        for (const word of kw.toLowerCase().split(/\s+/)) {
          if (word.length > 2) expandedKeywords.add(word);
        }
      }

      for (const job of jobs) {
        // Filter by keywords and location
        const titleLower = (job.title || '').toLowerCase();
        const locationLower = (job.location || '').toLowerCase();
        const tagsLower = (job.tags || []).map(t => t.toLowerCase());

        const matchesKeyword = [...expandedKeywords].some(kw => {
          return titleLower.includes(kw) || tagsLower.some(t => t.includes(kw));
        });

        const matchesLocation = locations.length === 0 || locations.some(loc => {
          const locLower = loc.toLowerCase();
          return locationLower.includes(locLower) || (locLower === 'remote' && job.remote);
        });

        if (matchesKeyword && matchesLocation) {
          allJobs.push(normalizeJob(job));
        }
      }

      // Check if more pages exist
      if (data.links && data.links.next) {
        page++;
      } else {
        break;
      }

      // Polite delay
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`  ✅ Arbeitnow: Found ${allJobs.length} matching jobs`);
  } catch (error) {
    console.error('  ❌ Arbeitnow Error:', error.message);
  }

  return allJobs;
}

function normalizeJob(job) {
  // Strip HTML tags from description
  const cleanDesc = (job.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    external_id: `arbeitnow_${job.slug || job.url || Math.random().toString(36).slice(2)}`,
    title: job.title || 'Unknown Title',
    company: job.company_name || 'Unknown Company',
    platform: 'arbeitnow',
    apply_link: job.url || `https://www.arbeitnow.com/view/${job.slug}`,
    apply_type: 'external',
    description: cleanDesc.slice(0, 5000),
    location: job.location || 'Not specified',
    tags: job.tags || [],
    remote: job.remote || false
  };
}
