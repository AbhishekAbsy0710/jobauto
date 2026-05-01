import { runAllScrapers } from '../scrapers/index.js';
import { initializeDb } from '../database.js';

initializeDb();
console.log('🔧 Manual scrape triggered\n');
const results = await runAllScrapers();
console.log('\nDone!', results);
process.exit(0);
