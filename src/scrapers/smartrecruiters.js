// SmartRecruiters public job board API scraper
// API: https://api.smartrecruiters.com/v1/companies/{company}/postings
// Apply URL: https://jobs.smartrecruiters.com/{company}/{jobId}
// No authentication needed — fully public

const SR_BASE = 'https://api.smartrecruiters.com/v1/companies';

// Keywords to filter relevant engineering/data roles
// Must appear in the job TITLE (not just department) to avoid broad false positives
const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'data engineer', 'data scientist', 'data analyst',
  'backend', 'frontend', 'full stack', 'fullstack', 'devops', 'devsecops',
  'cloud', 'platform engineer', 'infrastructure', 'machine learning', 'ml engineer',
  'ai engineer', 'software', 'sre', 'site reliability', 'python', 'typescript',
  'golang', 'rust developer', 'security engineer', 'kubernetes', 'solutions engineer',
  'staff engineer', 'principal engineer', 'systems engineer', 'reliability engineer',
  'data platform', 'data ops', 'mlops', 'analytics engineer'
];

export async function scrapeSmartRecruiters(companies = []) {
  const allJobs = [];

  for (const company of companies) {
    const { company_id, name } = company;
    try {
      let offset = 0;
      const limit = 100;
      let fetched = 0;

      while (true) {
        const url = `${SR_BASE}/${company_id}/postings?limit=${limit}&offset=${offset}`;
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });

        if (!resp.ok) {
          console.log(`  ⚠️ SmartRecruiters ${name}: HTTP ${resp.status}`);
          break;
        }

        const data = await resp.json();
        const postings = data.content || [];

        if (postings.length === 0) break;

        for (const job of postings) {
          const title = (job.name || '').toLowerCase();
          // Only match on title — department matching causes too many false positives
          const isTech = TECH_TITLE_KEYWORDS.some(kw => title.includes(kw));
          if (!isTech) continue;

          allJobs.push(normalizeJob(job, company_id, name));
          fetched++;
        }

        if (postings.length < limit) break;
        offset += limit;

        // Polite delay between pages
        await new Promise(r => setTimeout(r, 500));
      }

      if (fetched > 0) {
        console.log(`  ✅ SmartRecruiters ${name}: ${fetched} tech roles`);
      }
    } catch (err) {
      console.log(`  ⚠️ SmartRecruiters ${name}: ${err.message}`);
    }

    // Polite delay between companies
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`  ✅ SmartRecruiters total: ${allJobs.length} jobs`);
  return allJobs;
}

function normalizeJob(job, companyId, companyName) {
  // Build location string
  const loc = job.location;
  const locationStr = loc
    ? [loc.city, loc.country].filter(Boolean).join(', ')
    : 'Not specified';

  const isRemote = (job.location?.remote === true) ||
                   (job.workplace?.wfhPolicy === 'FULLY_REMOTE') ||
                   (job.name || '').toLowerCase().includes('remote');

  // Apply URL: SmartRecruiters job page (no Cloudflare, works from GHA)
  const applyUrl = `https://jobs.smartrecruiters.com/${companyId}/${job.id}`;

  return {
    external_id: `sr_${companyId}_${job.id}`,
    title: job.name || 'Unknown',
    company: companyName,
    platform: 'smartrecruiters',
    apply_link: applyUrl,
    apply_type: 'external',
    description: (job.jobAd?.sections?.jobDescription?.text || job.name || '').slice(0, 5000),
    location: locationStr,
    tags: [job.department?.label, job.function?.label].filter(Boolean),
    remote: isRemote,
  };
}
