import { scrapeArbeitnow } from './arbeitnow.js';
import { scrapeRemoteOK } from './remoteok.js';
import { scrapeJSearch } from './jsearch.js';
import { scanPortals } from './portals.js';
import { scrapeLinkedIn } from './linkedin.js';
import { scrapeIndeed } from './indeed.js';
import { scrapeStepStone } from './stepstone.js';
import { scrapeGlassdoor } from './glassdoor.js';
import { scrapeXing } from './xing.js';
import { insertJob } from '../database.js';
import { loadConfig, loadPortals } from '../config.js';

export async function runAllScrapers() {
  const config = loadConfig();
  const portals = loadPortals();
  const keywords = config.searchKeywords;
  const locations = config.searchLocations;
  const portalKeywords = portals.filter_keywords || keywords;

  console.log('\n🚀 Starting job scrape (9 platforms)...');
  console.log(`   Keywords: ${keywords.join(', ')}`);
  console.log(`   Locations: ${locations.join(', ')}`);
  console.log('');

  const results = { total: 0, new: 0, duplicates: 0, errors: 0 };

  // Run all scrapers — batch 1: fast APIs
  const [arbeitnowJobs, remoteOkJobs, jsearchJobs, portalJobs] = await Promise.allSettled([
    scrapeArbeitnow(keywords, locations),
    scrapeRemoteOK(keywords),
    scrapeJSearch(keywords, locations, config.jsearchApiKey),
    scanPortals(portalKeywords)
  ]);

  // Batch 2: web scrapers (slower, rate-limited)
  const [linkedinJobs, indeedJobs, stepstoneJobs, glassdoorJobs, xingJobs] = await Promise.allSettled([
    scrapeLinkedIn().catch(e => { console.log('⚠️ LinkedIn:', e.message); return []; }),
    scrapeIndeed().catch(e => { console.log('⚠️ Indeed:', e.message); return []; }),
    scrapeStepStone().catch(e => { console.log('⚠️ StepStone:', e.message); return []; }),
    scrapeGlassdoor().catch(e => { console.log('⚠️ Glassdoor:', e.message); return []; }),
    scrapeXing().catch(e => { console.log('⚠️ Xing:', e.message); return []; }),
  ]);

  const allJobs = [
    ...(arbeitnowJobs.status === 'fulfilled' ? arbeitnowJobs.value : []),
    ...(remoteOkJobs.status === 'fulfilled' ? remoteOkJobs.value : []),
    ...(jsearchJobs.status === 'fulfilled' ? jsearchJobs.value : []),
    ...(portalJobs.status === 'fulfilled' ? portalJobs.value : []),
    ...(linkedinJobs.status === 'fulfilled' ? linkedinJobs.value : []),
    ...(indeedJobs.status === 'fulfilled' ? indeedJobs.value : []),
    ...(stepstoneJobs.status === 'fulfilled' ? stepstoneJobs.value : []),
    ...(glassdoorJobs.status === 'fulfilled' ? glassdoorJobs.value : []),
    ...(xingJobs.status === 'fulfilled' ? xingJobs.value : []),
  ];

  results.total = allJobs.length;

  for (const job of allJobs) {
    try {
      const inserted = insertJob(job);
      if (inserted) results.new++;
      else results.duplicates++;
    } catch (error) {
      results.errors++;
      if (!error.message.includes('UNIQUE constraint')) {
        console.error(`  ❌ Insert error: ${error.message}`);
      }
    }
  }

  console.log('\n📊 Scrape Summary:');
  console.log(`   Total found: ${results.total}`);
  console.log(`   New jobs:    ${results.new}`);
  console.log(`   Duplicates:  ${results.duplicates}`);
  console.log(`   Errors:      ${results.errors}`);

  return results;
}
