// Uses native fetch (Node 18+)
import { loadPortals } from '../config.js';

/**
 * Career Portal Scanner — scans Greenhouse, Lever, and Ashby career pages.
 * Uses their public JSON APIs (no Playwright needed for these).
 */
export async function scanPortals(keywords = []) {
  const portals = loadPortals();
  const allJobs = [];

  console.log('\n🏢 Scanning career portals...');

  // Scan each portal type in parallel
  const [ghJobs, leverJobs, ashbyJobs] = await Promise.allSettled([
    scanGreenhouseBoards(portals.greenhouse || [], keywords),
    scanLeverBoards(portals.lever || [], keywords),
    scanAshbyBoards(portals.ashby || [], keywords)
  ]);

  allJobs.push(
    ...(ghJobs.status === 'fulfilled' ? ghJobs.value : []),
    ...(leverJobs.status === 'fulfilled' ? leverJobs.value : []),
    ...(ashbyJobs.status === 'fulfilled' ? ashbyJobs.value : [])
  );

  console.log(`  ✅ Portals: Found ${allJobs.length} matching jobs`);
  return allJobs;
}

// ============================================
// GREENHOUSE
// ============================================
async function scanGreenhouseBoards(boards, keywords) {
  const jobs = [];
  for (const board of boards) {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${board.board_id}/jobs?content=true`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        if (response.status === 404) console.log(`  ⚠️  Greenhouse: ${board.name} — board not found`);
        continue;
      }

      const data = await response.json();
      const boardJobs = (data.jobs || []).filter(j => matchesKeywords(j.title, keywords));

      for (const j of boardJobs) {
        const location = j.location?.name || 'Not specified';
        const desc = (j.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

        jobs.push({
          external_id: `greenhouse_${board.board_id}_${j.id}`,
          title: j.title,
          company: board.name,
          platform: 'greenhouse',
          apply_link: j.absolute_url || `https://boards.greenhouse.io/${board.board_id}/jobs/${j.id}`,
          apply_type: 'external',
          description: desc.slice(0, 5000),
          location: location,
          tags: (j.departments || []).map(d => d.name),
          remote: location.toLowerCase().includes('remote')
        });
      }

      console.log(`  🌿 Greenhouse/${board.name}: ${boardJobs.length} jobs`);
      await delay(500);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`  ❌ Greenhouse/${board.name}: ${error.message}`);
      }
    }
  }
  return jobs;
}

// ============================================
// LEVER
// ============================================
async function scanLeverBoards(boards, keywords) {
  const jobs = [];
  for (const board of boards) {
    try {
      const url = `https://api.lever.co/v0/postings/${board.company_id}?mode=json`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const boardJobs = (Array.isArray(data) ? data : []).filter(j => matchesKeywords(j.text, keywords));

      for (const j of boardJobs) {
        const location = j.categories?.location || 'Not specified';
        const desc = (j.descriptionPlain || j.description || '').replace(/<[^>]*>/g, ' ').trim();

        jobs.push({
          external_id: `lever_${board.company_id}_${j.id}`,
          title: j.text,
          company: board.name,
          platform: 'lever',
          apply_link: j.hostedUrl || j.applyUrl || '#',
          apply_type: 'external',
          description: desc.slice(0, 5000),
          location: location,
          tags: [j.categories?.team, j.categories?.department].filter(Boolean),
          remote: location.toLowerCase().includes('remote')
        });
      }

      console.log(`  🔷 Lever/${board.name}: ${boardJobs.length} jobs`);
      await delay(500);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`  ❌ Lever/${board.name}: ${error.message}`);
      }
    }
  }
  return jobs;
}

// ============================================
// ASHBY
// ============================================
async function scanAshbyBoards(boards, keywords) {
  const jobs = [];
  for (const board of boards) {
    try {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${board.company_id}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const boardJobs = (data.jobs || []).filter(j => matchesKeywords(j.title, keywords));

      for (const j of boardJobs) {
        const location = j.location || j.locationName || 'Not specified';

        jobs.push({
          external_id: `ashby_${board.company_id}_${j.id}`,
          title: j.title,
          company: board.name,
          platform: 'ashby',
          apply_link: j.jobUrl || `https://jobs.ashbyhq.com/${board.company_id}/${j.id}`,
          apply_type: 'external',
          description: (j.descriptionPlain || j.description || '').slice(0, 5000),
          location: location,
          tags: [j.department, j.team].filter(Boolean),
          remote: (typeof location === 'string' && location.toLowerCase().includes('remote'))
        });
      }

      console.log(`  🟣 Ashby/${board.name}: ${boardJobs.length} jobs`);
      await delay(500);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`  ❌ Ashby/${board.name}: ${error.message}`);
      }
    }
  }
  return jobs;
}

// ============================================
// HELPERS
// ============================================
function matchesKeywords(title, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const titleLower = (title || '').toLowerCase();
  return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
