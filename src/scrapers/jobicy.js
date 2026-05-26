// Jobicy.com public job API scraper
// API: https://jobicy.com/api/v2/remote-jobs
// Free, no auth, returns remote jobs by region

const SEARCHES = [
  { geo: 'europe', industry: 'dev', tag: 'EU Dev' },
  { geo: 'europe', industry: 'devops', tag: 'EU DevOps' },
  { geo: 'europe', industry: 'data', tag: 'EU Data' },
  { geo: 'europe', industry: 'infosec', tag: 'EU Security' },
  { geo: 'germany', industry: 'dev', tag: 'DE Dev' },
  { geo: 'uk', industry: 'dev', tag: 'UK Dev' },
  { geo: 'worldwide', industry: 'dev', tag: 'Global Dev' },
];

export async function scrapeJobicy() {
  console.log('🔍 Scraping Jobicy (remote jobs API)...');
  const allJobs = [];
  const seen = new Set();

  for (const search of SEARCHES) {
    try {
      const url = `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${search.geo}&industry=${search.industry}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.log(`  ⚠️ Jobicy ${search.tag}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const jobs = data.jobs || [];

      for (const job of jobs) {
        const id = `jobicy_${job.id || Buffer.from(job.jobTitle + job.companyName).toString('base64').slice(0, 30)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        allJobs.push({
          external_id: id,
          title: job.jobTitle,
          company: job.companyName || 'Unknown',
          platform: 'Jobicy',
          apply_link: job.url || '#',
          apply_type: 'external',
          description: (job.jobDescription || job.jobExcerpt || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 5000),
          location: job.jobGeo || 'Remote',
          tags: [job.jobIndustry, ...(job.jobType || [])].flat().filter(Boolean),
          remote: true,
          posted_at: job.pubDate || new Date().toISOString(),
        });
      }

      console.log(`  ✅ Jobicy ${search.tag}: ${jobs.length} jobs`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ⚠️ Jobicy ${search.tag}: ${err.message}`);
    }
  }

  console.log(`📦 Jobicy total: ${allJobs.length} remote jobs`);
  return allJobs;
}
