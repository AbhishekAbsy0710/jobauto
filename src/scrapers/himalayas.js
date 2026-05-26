// Himalayas.app public job API scraper
// API: https://himalayas.app/jobs/api
// Free, no auth, returns remote jobs globally

const EU_LOCATIONS = [
  'europe', 'eu', 'germany', 'berlin', 'munich', 'frankfurt',
  'netherlands', 'amsterdam', 'france', 'paris', 'switzerland', 'zurich',
  'austria', 'vienna', 'uk', 'london', 'ireland', 'dublin',
  'spain', 'barcelona', 'sweden', 'stockholm', 'denmark', 'copenhagen',
  'finland', 'helsinki', 'belgium', 'portugal', 'lisbon', 'luxembourg',
  'emea', 'worldwide', 'anywhere', 'global', 'remote',
];

const TECH_CATEGORIES = [
  'engineering', 'software', 'devops', 'data', 'infrastructure',
  'security', 'cloud', 'backend', 'frontend', 'fullstack',
];

export async function scrapeHimalayas() {
  console.log('🔍 Scraping Himalayas (remote jobs API)...');
  const allJobs = [];

  try {
    // Himalayas returns paginated results
    let page = 1;
    const limit = 50;

    while (page <= 3) { // Max 3 pages = 150 jobs
      const url = `https://himalayas.app/jobs/api?limit=${limit}&offset=${(page - 1) * limit}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Himalayas page ${page}: HTTP ${resp.status}`);
        break;
      }

      const data = await resp.json();
      const jobs = data.jobs || [];
      if (jobs.length === 0) break;

      for (const job of jobs) {
        // Filter by location (EU/Remote)
        const locationLower = (job.location || '').toLowerCase();
        const isEU = EU_LOCATIONS.some(loc => locationLower.includes(loc));
        
        // Filter by category (tech roles)
        const categoryLower = (job.categories || []).join(' ').toLowerCase();
        const titleLower = (job.title || '').toLowerCase();
        const isTech = TECH_CATEGORIES.some(cat => categoryLower.includes(cat) || titleLower.includes(cat));

        if (!isEU && !isTech) continue;

        allJobs.push({
          external_id: `himalayas_${job.id || Buffer.from(job.title + job.companyName).toString('base64').slice(0, 30)}`,
          title: job.title,
          company: job.companyName || 'Unknown',
          platform: 'Himalayas',
          apply_link: job.applicationUrl || job.url || '#',
          apply_type: 'external',
          description: (job.description || job.excerpt || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000),
          location: job.location || 'Remote',
          tags: job.categories || [],
          remote: true,
          posted_at: job.pubDate || new Date().toISOString(),
        });
      }

      page++;
      await new Promise(r => setTimeout(r, 800));
    }
  } catch (err) {
    console.log(`  ⚠️ Himalayas: ${err.message}`);
  }

  console.log(`📦 Himalayas total: ${allJobs.length} EU remote jobs`);
  return allJobs;
}
