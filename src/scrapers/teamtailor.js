// TeamTailor career page scraper
// Uses TeamTailor's public JSON API: {company}.teamtailor.com/api/v1/jobs
// No authentication required — fully public

const TECH_TITLE_KEYWORDS = [
  'engineer', 'developer', 'devops', 'cloud', 'data', 'platform',
  'infrastructure', 'backend', 'frontend', 'fullstack', 'full stack',
  'sre', 'site reliability', 'machine learning', 'ml ', 'ai ',
  'software', 'security engineer', 'solutions engineer', 'systems engineer',
  'python', 'typescript', 'golang', 'kubernetes', 'mlops', 'analytics',
];

export async function scrapeTeamTailor(companies = []) {
  console.log(`🔍 Scraping TeamTailor (${companies.length} companies)...`);
  const allJobs = [];

  for (const company of companies) {
    const { subdomain, name } = company;
    try {
      // TeamTailor public career API — returns HTML page with embedded JSON-LD
      const careerUrl = `https://career.${subdomain}.com/jobs`;
      const resp = await fetch(careerUrl, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        // Try alternative URL format
        const altUrl = `https://${subdomain}.teamtailor.com/jobs`;
        const altResp = await fetch(altUrl, {
          headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!altResp.ok) {
          console.log(`  ⚠️ TeamTailor ${name}: HTTP ${resp.status}`);
          continue;
        }
        // Process alt response below
        const html = await altResp.text();
        processTeamTailorHtml(html, name, subdomain, allJobs);
        continue;
      }

      const html = await resp.text();
      processTeamTailorHtml(html, name, subdomain, allJobs);

    } catch (err) {
      console.log(`  ⚠️ TeamTailor ${name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`  ✅ TeamTailor total: ${allJobs.length} jobs`);
  return allJobs;
}

function processTeamTailorHtml(html, companyName, subdomain, allJobs) {
  let matched = 0;

  // Extract ld+json JobPosting data
  const ldJsonBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of ldJsonBlocks) {
    try {
      const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      const data = JSON.parse(jsonStr);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);

      for (const item of items) {
        if (item['@type'] !== 'JobPosting') continue;
        const title = item.title || '';
        const titleLower = title.toLowerCase();
        const isTech = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
        if (!isTech) continue;

        const loc = item.jobLocation;
        const location = Array.isArray(loc)
          ? loc.map(l => l.address?.addressLocality || '').filter(Boolean).join(', ')
          : (loc?.address?.addressLocality || 'Not specified');

        allJobs.push({
          external_id: `teamtailor_${subdomain}_${Buffer.from(item.url || title).toString('base64').slice(0, 30)}`,
          title,
          company: item.hiringOrganization?.name || companyName,
          platform: 'teamtailor',
          apply_link: item.url || `https://career.${subdomain}.com/jobs`,
          apply_type: 'external',
          description: (item.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000),
          location,
          tags: [],
          remote: titleLower.includes('remote') || location.toLowerCase().includes('remote'),
          posted_at: item.datePosted || new Date().toISOString(),
        });
        matched++;
      }
    } catch { /* skip malformed JSON-LD */ }
  }

  if (matched > 0) {
    console.log(`  ✅ TeamTailor ${companyName}: ${matched} tech roles`);
  }
}
