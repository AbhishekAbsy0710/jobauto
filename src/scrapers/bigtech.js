// Big Tech direct career page scrapers
// Each company has a custom API behind their career site
// All verified working as of 2026-05-26

const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data engineer', 'data scientist',
  'data analyst', 'backend', 'frontend', 'full stack', 'fullstack',
  'platform engineer', 'infrastructure', 'machine learning', 'ml engineer',
  'ai engineer', 'software', 'sre', 'site reliability', 'security engineer',
  'solutions engineer', 'systems engineer', 'staff engineer', 'principal engineer',
  'reliability engineer', 'analytics engineer', 'mlops', 'kubernetes',
];

// ============================================
// AMAZON JOBS — https://www.amazon.jobs
// Public JSON API, no auth needed
// ============================================
const AMAZON_EU_COUNTRIES = [
  { code: 'DEU', name: 'Germany' },
  { code: 'NLD', name: 'Netherlands' },
  { code: 'LUX', name: 'Luxembourg' },
  { code: 'FRA', name: 'France' },
  { code: 'GBR', name: 'UK' },
  { code: 'IRL', name: 'Ireland' },
  { code: 'ESP', name: 'Spain' },
  { code: 'CHE', name: 'Switzerland' },
  { code: 'AUT', name: 'Austria' },
  { code: 'SWE', name: 'Sweden' },
];

async function scrapeAmazon() {
  const allJobs = [];

  for (const country of AMAZON_EU_COUNTRIES) {
    try {
      let offset = 0;
      const limit = 100;

      while (offset < 500) { // Max 500 jobs per country
        const url = `https://www.amazon.jobs/en/search.json?base_query=&offset=${offset}&result_limit=${limit}&country=${country.code}`;
        const resp = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
          console.log(`  ⚠️ Amazon ${country.name}: HTTP ${resp.status}`);
          break;
        }

        const data = await resp.json();
        const jobs = data.jobs || [];
        if (jobs.length === 0) break;

        for (const job of jobs) {
          const titleLower = (job.title || '').toLowerCase();
          const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
          if (!isTech) continue;

          allJobs.push({
            external_id: `amazon_${job.id_icims || job.job_path?.replace(/\//g, '_') || String(offset)}`,
            title: job.title,
            company: job.company_name || 'Amazon',
            platform: 'amazon',
            apply_link: `https://www.amazon.jobs${job.job_path || ''}`,
            apply_type: 'external',
            description: (job.description || job.basic_qualifications || job.title || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000),
            location: job.normalized_location || job.location || country.name,
            tags: [job.job_category, job.business_category].filter(Boolean),
            remote: (job.title || '').toLowerCase().includes('remote') || (job.location || '').toLowerCase().includes('remote'),
            posted_at: job.posted_date || new Date().toISOString(),
          });
        }

        if (jobs.length < limit) break;
        offset += limit;
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.log(`  ⚠️ Amazon ${country.name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`  ✅ Amazon: ${allJobs.length} EU tech roles`);
  return allJobs;
}

// ============================================
// NVIDIA — Workday with custom tenant
// Uses NVIDIAExternalCareerSite board
// ============================================
const NVIDIA_EU_LOCATIONS = [
  // Country codes NVIDIA uses in location text
  'DE,', 'NL,', 'GB,', 'FI,', 'CH,', 'FR,', 'SE,', 'IE,', 'AT,', 'PL,',
  'CZ,', 'DK,', 'IT,', 'ES,', 'BE,', 'LU,',
  // Full names (for multi-location entries)
  'germany', 'munich', 'berlin', 'frankfurt',
  'netherlands', 'amsterdam', 'eindhoven',
  'finland', 'helsinki', 'switzerland', 'zurich',
  'france', 'paris', 'sweden', 'stockholm',
  'united kingdom', 'london', 'uk,', 'ireland', 'dublin',
  'austria', 'vienna', 'poland', 'warsaw',
  'remote', 'europe', 'emea',
];

async function scrapeNVIDIA() {
  const allJobs = [];

  try {
    let offset = 0;
    const limit = 20;

    while (offset < 200) { // Max 200 results
      const url = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
        body: JSON.stringify({
          appliedFacets: {},
          limit,
          offset,
          searchText: '',
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ NVIDIA: HTTP ${resp.status}`);
        break;
      }

      const data = await resp.json();
      const postings = data.jobPostings || [];
      if (postings.length === 0) break;

      for (const job of postings) {
        const titleLower = (job.title || '').toLowerCase();
        const locText = (job.locationsText || '');
        const locLower = locText.toLowerCase();
        const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
        // Accept if EU location found, or if it's a multi-location posting (e.g. "3 Locations")
        const isEU = NVIDIA_EU_LOCATIONS.some(loc => locLower.includes(loc.toLowerCase()));
        const isMultiLoc = /\\d+ locations/i.test(locText);

        if (!isTech || (!isEU && !isMultiLoc)) continue;

        const applyUrl = `https://nvidia.wd5.myworkdayjobs.com${job.externalPath || ''}`;

        allJobs.push({
          external_id: `nvidia_${job.bulletFields?.[0] || Buffer.from(applyUrl).toString('base64').slice(0, 30)}`,
          title: job.title,
          company: 'NVIDIA',
          platform: 'nvidia',
          apply_link: applyUrl,
          apply_type: 'external',
          description: (job.title || ''),
          location: job.locationsText || 'Not specified',
          tags: [],
          remote: locText.includes('remote'),
          posted_at: job.postedOn || new Date().toISOString(),
        });
      }

      if (postings.length < limit) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.log(`  ⚠️ NVIDIA: ${err.message}`);
  }

  console.log(`  ✅ NVIDIA: ${allJobs.length} EU tech roles`);
  return allJobs;
}

// ============================================
// Main export — runs all big tech scrapers
// ============================================
export async function scrapeBigTech() {
  console.log('🏢 Scraping Big Tech career pages...');

  const [amazonJobs, nvidiaJobs] = await Promise.allSettled([
    scrapeAmazon(),
    scrapeNVIDIA(),
  ]);

  const allJobs = [
    ...(amazonJobs.status === 'fulfilled' ? amazonJobs.value : []),
    ...(nvidiaJobs.status === 'fulfilled' ? nvidiaJobs.value : []),
  ];

  console.log(`📦 Big Tech total: ${allJobs.length} EU tech roles`);
  return allJobs;
}
