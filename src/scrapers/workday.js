// Workday career page scraper
// Uses the public JSON search endpoint at {company}.wd{N}.myworkdayjobs.com
// No authentication required — fully public

const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data', 'platform',
  'infrastructure', 'backend', 'frontend', 'fullstack', 'full stack',
  'sre', 'site reliability', 'machine learning', 'ml ', 'ai ',
  'software', 'security engineer', 'solutions engineer', 'systems engineer',
  'python', 'typescript', 'golang', 'kubernetes', 'mlops', 'analytics',
];

export async function scrapeWorkday(companies = []) {
  console.log(`🔍 Scraping Workday (${companies.length} companies)...`);
  const allJobs = [];

  for (const company of companies) {
    const { tenant, instance = 'wd1', name } = company;
    try {
      // Workday public search JSON endpoint
      const searchUrl = `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/External/jobs`;
      const body = JSON.stringify({
        appliedFacets: {},
        limit: 20,
        offset: 0,
        searchText: '',
      });

      const resp = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Workday ${name}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const postings = data.jobPostings || [];
      let matched = 0;

      for (const job of postings) {
        const titleLower = (job.title || '').toLowerCase();
        const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
        if (!isTech) continue;

        const applyUrl = `https://${tenant}.${instance}.myworkdayjobs.com${job.externalPath || ''}`;

        // Fetch full description if available
        let description = job.title || '';
        try {
          const detailUrl = `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/External${job.externalPath}`;
          const detResp = await fetch(detailUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (detResp.ok) {
            const detail = await detResp.json();
            const jd = detail.jobPostingInfo;
            description = (jd?.jobDescription || '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 5000);
          }
          await new Promise(r => setTimeout(r, 300));
        } catch { /* use title as description */ }

        const locParts = [];
        if (job.locationsText) locParts.push(job.locationsText);
        const location = locParts.join(', ') || 'Not specified';

        allJobs.push({
          external_id: `workday_${tenant}_${job.bulletFields?.[0] || Buffer.from(applyUrl).toString('base64').slice(0, 30)}`,
          title: job.title || 'Unknown',
          company: name,
          platform: 'workday',
          apply_link: applyUrl,
          apply_type: 'external',
          description,
          location,
          tags: [],
          remote: titleLower.includes('remote') || (job.locationsText || '').toLowerCase().includes('remote'),
          posted_at: job.postedOn || new Date().toISOString(),
        });
        matched++;
      }

      if (matched > 0) {
        console.log(`  ✅ Workday ${name}: ${matched} tech roles`);
      }
    } catch (err) {
      console.log(`  ⚠️ Workday ${name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`  ✅ Workday total: ${allJobs.length} jobs`);
  return allJobs;
}
