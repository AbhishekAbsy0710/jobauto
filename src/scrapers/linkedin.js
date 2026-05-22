// LinkedIn public job scraper — EU only
// Uses LinkedIn's public job search (no auth required)

const EU_SEARCHES = [
  { keywords: 'DevOps Engineer', location: 'Germany', geoId: '101282230' },
  { keywords: 'Cloud Engineer', location: 'Germany', geoId: '101282230' },
  { keywords: 'Full Stack Developer', location: 'Netherlands', geoId: '102890719' },
  { keywords: 'Data Engineer', location: 'Switzerland', geoId: '106693272' },
  { keywords: 'Platform Engineer', location: 'Germany', geoId: '101282230' },
  { keywords: 'Software Engineer', location: 'France', geoId: '105015875' },
  { keywords: 'Infrastructure Engineer', location: 'Austria', geoId: '103883259' },
  { keywords: 'Site Reliability Engineer', location: 'Europe', geoId: '' },
  { keywords: 'AI Engineer', location: 'Germany', geoId: '101282230' },
  { keywords: 'Backend Developer', location: 'Luxembourg', geoId: '104042105' },
];

export async function scrapeLinkedIn() {
  console.log('🔍 Scraping LinkedIn (public job search)...');
  const jobs = [];

  for (const search of EU_SEARCHES) {
    try {
      // LinkedIn public job search HTML
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(search.keywords)}&location=${encodeURIComponent(search.location)}&geoId=${search.geoId}&f_TPR=r604800&start=0`;

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`  ⚠️ LinkedIn ${search.keywords}/${search.location}: ${res.status}`); continue; }
      const html = await res.text();

      // Parse the HTML for job cards
      const cardRegex = /<div class="base-card[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
      const cards = html.match(cardRegex) || [];

      for (const card of cards) {
        const title = (card.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\//)?.[1] || '').trim();
        const company = (card.match(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\//)?.[1] || '').trim();
        const location = (card.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\//)?.[1] || search.location).trim();
        const link = (card.match(/href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]*?)"/)?.[1] || '').trim();
        const dateStr = (card.match(/datetime="([^"]*)"/)?.[1] || '').trim();

        if (title && link) {
          // Fetch full job description from the individual job page
          let description = `${title} at ${company} in ${location}`;
          try {
            const jobPageUrl = link.split('?')[0]; // strip tracking params
            const jobRes = await fetch(jobPageUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
              },
              signal: AbortSignal.timeout(10000)
            });
            if (jobRes.ok) {
              const jobHtml = await jobRes.text();
              // Extract description from show-more-less-html__markup (LinkedIn public job pages)
              const descMatch = jobHtml.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
              if (descMatch) {
                description = descMatch[1]
                  .replace(/<br\s*\/?>/gi, '\n')
                  .replace(/<\/?(p|li|ul|ol|h[1-6]|div|span|strong|em|b|i|a)[^>]*>/gi, ' ')
                  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 5000);
              }
            }
            await new Promise(r => setTimeout(r, 1500)); // extra delay per job page
          } catch { /* keep placeholder description */ }

          jobs.push({
            title,
            company: company || 'Unknown',
            location: location || search.location,
            description,
            apply_link: link,
            platform: 'linkedin',
            external_id: `linkedin_${link.match(/view\/(\d+)/)?.[1] || Buffer.from(link).toString('base64').slice(0, 30)}`,
            tags: [search.keywords],
            posted_at: dateStr || new Date().toISOString(),
          });
        }
      }
      console.log(`  ✅ LinkedIn ${search.keywords}/${search.location}: ${cards.length} jobs`);
    } catch (e) {
      console.log(`  ⚠️ LinkedIn ${search.keywords}/${search.location}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000)); // rate limit
  }

  console.log(`📦 LinkedIn total: ${jobs.length} EU jobs`);
  return jobs;
}
