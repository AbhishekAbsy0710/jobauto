// Uses native fetch (Node 18+)

const API_URL = 'https://remoteok.com/api';

export async function scrapeRemoteOK(keywords = []) {
  const allJobs = [];

  try {
    console.log('  🌍 RemoteOK: Fetching remote jobs...');

    const response = await fetch(API_URL, {
      headers: {
        'User-Agent': 'JobAuto/1.0 (job matching assistant)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.log(`  ⚠️ RemoteOK returned ${response.status}`);
      return [];
    }

    const data = await response.json();

    // First element is metadata, skip it
    const jobs = Array.isArray(data) ? data.slice(1) : [];

    // Broaden keywords: split "DevOps Engineer" into ["devops", "engineer"] + add common tech terms
    const TECH_TERMS = ['devops', 'cloud', 'fullstack', 'full-stack', 'full stack', 'backend', 'data engineer',
      'sre', 'platform engineer', 'infrastructure', 'ml engineer', 'ai engineer', 'machine learning',
      'site reliability', 'kubernetes', 'terraform', 'aws', 'azure', 'gcp'];
    const expandedKeywords = new Set(TECH_TERMS);
    for (const kw of keywords) {
      expandedKeywords.add(kw.toLowerCase());
      // Also add individual words (2+ chars) from multi-word keywords
      for (const word of kw.toLowerCase().split(/\s+/)) {
        if (word.length > 2) expandedKeywords.add(word);
      }
    }

    for (const job of jobs) {
      if (!job.position) continue;

      const titleLower = (job.position || '').toLowerCase();
      const descLower = (job.description || '').toLowerCase();
      const tagsLower = (job.tags || []).map(t => t.toLowerCase());

      const matchesKeyword = [...expandedKeywords].some(kw => {
        return titleLower.includes(kw) || tagsLower.some(t => t.includes(kw));
      });

      if (matchesKeyword) {
        allJobs.push(normalizeJob(job));
      }
    }

    console.log(`  ✅ RemoteOK: Found ${allJobs.length} matching jobs`);
  } catch (error) {
    console.error('  ❌ RemoteOK Error:', error.message);
  }

  return allJobs;
}

function normalizeJob(job) {
  const cleanDesc = (job.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    external_id: `remoteok_${job.id || job.slug || Math.random().toString(36).slice(2)}`,
    title: job.position || 'Unknown Title',
    company: job.company || 'Unknown Company',
    platform: 'remoteok',
    apply_link: job.url || `https://remoteok.com/remote-jobs/${job.slug}`,
    apply_type: 'external',
    description: cleanDesc.slice(0, 5000),
    location: job.location || 'Remote',
    tags: job.tags || [],
    remote: true
  };
}
