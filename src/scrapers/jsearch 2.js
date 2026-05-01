import fetch from 'node-fetch';

const BASE_URL = 'https://jsearch.p.rapidapi.com/search';

export async function scrapeJSearch(keywords = [], locations = [], apiKey = '') {
  if (!apiKey) {
    console.log('  ⚠️ JSearch: No API key configured — skipping (get free key at rapidapi.com)');
    return [];
  }

  const allJobs = [];

  try {
    // Combine first keyword with first location for efficient API usage (free tier = 200/mo)
    const queries = [];
    const kw = keywords.slice(0, 2); // max 2 keywords to conserve free quota
    const loc = locations.slice(0, 2);

    for (const keyword of kw) {
      for (const location of loc) {
        queries.push(`${keyword} in ${location}`);
      }
    }

    for (const query of queries.slice(0, 3)) { // max 3 queries per run
      console.log(`  🔍 JSearch: Searching "${query}"...`);

      const params = new URLSearchParams({
        query: query,
        page: '1',
        num_pages: '1',
        date_posted: 'week'
      });

      const response = await fetch(`${BASE_URL}?${params}`, {
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        }
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.log('  ⚠️ JSearch: Rate limit hit — free tier exhausted for today');
          break;
        }
        console.log(`  ⚠️ JSearch returned ${response.status}`);
        continue;
      }

      const data = await response.json();
      const jobs = data.data || [];

      for (const job of jobs) {
        allJobs.push(normalizeJob(job));
      }

      // Be polite with free tier
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`  ✅ JSearch: Found ${allJobs.length} matching jobs`);
  } catch (error) {
    console.error('  ❌ JSearch Error:', error.message);
  }

  return allJobs;
}

function normalizeJob(job) {
  // Determine apply type
  let applyType = 'external';
  const applyLink = job.job_apply_link || '';
  if (applyLink.includes('linkedin.com') || applyLink.includes('indeed.com')) {
    applyType = 'easy_apply';
  }

  // Determine platform source
  let platform = 'jsearch';
  if (job.job_publisher) {
    const pub = job.job_publisher.toLowerCase();
    if (pub.includes('linkedin')) platform = 'linkedin';
    else if (pub.includes('indeed')) platform = 'indeed';
    else if (pub.includes('glassdoor')) platform = 'glassdoor';
  }

  return {
    external_id: `jsearch_${job.job_id || Math.random().toString(36).slice(2)}`,
    title: job.job_title || 'Unknown Title',
    company: job.employer_name || 'Unknown Company',
    platform: platform,
    apply_link: applyLink || '#',
    apply_type: applyType,
    description: (job.job_description || '').slice(0, 5000),
    location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') || 'Not specified',
    tags: job.job_required_skills || [],
    remote: job.job_is_remote || false
  };
}
