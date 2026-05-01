// Glassdoor scraper — EU tech jobs
// Uses Glassdoor's public search page

const QUERIES = [
  { q: 'DevOps Engineer', l: 'Germany' },
  { q: 'Cloud Engineer', l: 'Switzerland' },
  { q: 'Software Engineer', l: 'Netherlands' },
  { q: 'Data Engineer', l: 'France' },
  { q: 'Full Stack Developer', l: 'Germany' },
];

export async function scrapeGlassdoor() {
  console.log('🔍 Scraping Glassdoor (EU)...');
  const jobs = [];

  for (const { q, l } of QUERIES) {
    try {
      const url = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}&locT=N&locId=&locKeyword=${encodeURIComponent(l)}&jobType=&fromAge=7&minSalary=0&includeNoSalaryJobs=true&radius=100&cityId=&minRating=0.0&industryId=&sgocId=&seniorityType=&companyId=&employerSizes=0&applicationType=0&remoteWorkType=0`;

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`  ⚠️ Glassdoor ${q}/${l}: ${res.status}`); continue; }
      const html = await res.text();

      // Extract structured data
      const ldJson = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      for (const match of ldJson) {
        try {
          const data = JSON.parse(match.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
          const items = Array.isArray(data) ? data : (data.itemListElement || [data]);
          for (const item of items) {
            const posting = item.item || item;
            if (posting['@type'] !== 'JobPosting') continue;
            jobs.push({
              title: posting.title || '',
              company: posting.hiringOrganization?.name || 'Unknown',
              location: posting.jobLocation?.address?.addressLocality || l,
              description: (posting.description || '').replace(/<[^>]*>/g, '').slice(0, 2000),
              apply_link: posting.url || url,
              platform: 'glassdoor',
              external_id: `glassdoor_${Buffer.from(posting.url || posting.title || '').toString('base64').slice(0, 40)}`,
              tags: [q],
              posted_at: posting.datePosted || new Date().toISOString(),
            });
          }
        } catch {}
      }
      console.log(`  ✅ Glassdoor ${q}/${l}: parsed`);
    } catch (e) {
      console.log(`  ⚠️ Glassdoor ${q}/${l}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`📦 Glassdoor total: ${jobs.length} jobs`);
  return jobs;
}
