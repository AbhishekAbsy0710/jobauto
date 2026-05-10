import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { callGroq } from './browser-apply.js'; // Need to export callGroq or move this to browser-apply.js
