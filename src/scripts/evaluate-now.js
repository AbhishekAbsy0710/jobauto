import { evaluateNewJobs } from '../services/actionRouter.js';
import { initializeDb } from '../database.js';

initializeDb();
console.log('🔧 Manual evaluation triggered\n');
const results = await evaluateNewJobs(50, 1); // Retry logic handles Groq rate limits
console.log('\nDone!', results);
process.exit(0);
