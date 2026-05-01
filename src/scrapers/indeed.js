// Indeed Germany + EU scraper
// Uses regional Indeed RSS feeds which are less protected

const FEEDS = [
  // Indeed Germany
  { url: 'https://de.indeed.com/rss?q=DevOps+Engineer&l=Deutschland&sort=date', loc: 'Germany' },
  { url: 'https://de.indeed.com/rss?q=Cloud+Engineer&l=Deutschland&sort=date', loc: 'Germany' },
  { url: 'https://de.indeed.com/rss?q=Software+Engineer&l=München&sort=date', loc: 'Munich' },
  { url: 'https://de.indeed.com/rss?q=Data+Engineer&l=Berlin&sort=date', loc: 'Berlin' },
  { url: 'https://de.indeed.com/rss?q=Full+Stack+Developer&l=Deutschland&sort=date', loc: 'Germany' },
  // Indeed Netherlands
  { url: 'https://nl.indeed.com/rss?q=DevOps+Engineer&l=Nederland&sort=date', loc: 'Netherlands' },
  // Indeed Switzerland
  { url: 'https://ch.indeed.com/rss?q=Cloud+Engineer&l=Schweiz&sort=date', loc: 'Switzerland' },
  // Indeed France
  { url: 'https://fr.indeed.com/rss?q=DevOps+Engineer&l=France&sort=date', loc: 'France' },
  // Indeed Austria
  { url: 'https://at.indeed.com/rss?q=Software+Engineer&l=Wien&sort=date', loc: 'Vienna' },
];

export async function scrapeIndeed() {
  console.log('🔍 Scraping Indeed (EU regional feeds)...');
  const jobs = [];

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`  ⚠️ Indeed ${feed.loc}: ${res.status}`); continue; }
      const xml = await res.text();

      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
        const link = (item.match(/<link>(.*?)<\/link>/)?.[1] || '').trim();
        const company = (item.match(/<source.*?>(.*?)<\/source>/)?.[1] || '').trim();
        const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '').trim();
        const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]>/)?.[1] || '').replace(/<[^>]*>/g, '').trim();

        if (title && link) {
          jobs.push({
            title,
            company: company || 'Unknown',
            location: feed.loc,
            description: desc.slice(0, 2000),
            apply_link: link,
            platform: 'indeed',
            external_id: `indeed_${Buffer.from(link).toString('base64').slice(0, 40)}`,
            tags: [],
            posted_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          });
        }
      }
      console.log(`  ✅ Indeed ${feed.loc}: ${items.length} jobs`);
    } catch (e) {
      console.log(`  ⚠️ Indeed ${feed.loc}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`📦 Indeed total: ${jobs.length} EU jobs`);
  return jobs;
}
