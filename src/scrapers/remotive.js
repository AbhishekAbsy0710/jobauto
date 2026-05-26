// Remotive.com public job API scraper
// API: https://remotive.com/api/remote-jobs
// Free, no auth, no rate limits
// Returns remote-friendly jobs worldwide

const CATEGORIES = ['software-dev', 'devops', 'data', 'infosec', 'qa'];

const EU_LOCATIONS = [
  'europe', 'eu', 'germany', 'berlin', 'munich', 'frankfurt', 'hamburg',
  'netherlands', 'amsterdam', 'france', 'paris', 'switzerland', 'zurich',
  'austria', 'vienna', 'luxembourg', 'uk', 'london', 'ireland', 'dublin',
  'spain', 'barcelona', 'madrid', 'italy', 'milan', 'sweden', 'stockholm',
  'denmark', 'copenhagen', 'finland', 'helsinki', 'belgium', 'brussels',
  'portugal', 'lisbon', 'emea', 'worldwide', 'anywhere', 'global',
];

export async function scrapeRemotive() {
  console.log('🔍 Scraping Remotive (remote jobs API)...');
  const allJobs = [];

  for (const category of CATEGORIES) {
    try {
      const url = `https://remotive.com/api/remote-jobs?category=${category}&limit=50`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Remotive ${category}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const jobs = data.jobs || [];

      for (const job of jobs) {
        // Filter to EU/Remote-friendly locations
        const locationLower = (job.candidate_required_location || '').toLowerCase();
        const isEU = EU_LOCATIONS.some(loc => locationLower.includes(loc));
        if (!isEU) continue;

        // Strip HTML from description
        const desc = (job.description || '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        allJobs.push({
          external_id: `remotive_${job.id}`,
          title: job.title,
          company: job.company_name || 'Unknown',
          platform: 'Remotive',
          apply_link: job.url || '#',
          apply_type: 'external',
          description: desc.slice(0, 5000),
          location: job.candidate_required_location || 'Remote',
          tags: [job.category, ...(job.tags || [])].filter(Boolean),
          remote: true,
          posted_at: job.publication_date || new Date().toISOString(),
        });
      }

      console.log(`  ✅ Remotive ${category}: ${jobs.length} found, ${allJobs.length} EU-eligible`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ⚠️ Remotive ${category}: ${err.message}`);
    }
  }

  console.log(`📦 Remotive total: ${allJobs.length} EU remote jobs`);
  return allJobs;
}
