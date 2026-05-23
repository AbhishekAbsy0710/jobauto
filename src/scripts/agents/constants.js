/**
 * agents/constants.js — Shared Configuration & Constants
 * 
 * Centralized profile data, static answer cache, keyword lists, and selector constants.
 * All agents import from here — single source of truth.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..', '..');
export const RESUME_PATH = join(ROOT, 'resume', 'resume.pdf');

// Load profile YAML text for AI prompts
export const PROFILE_YAML = (() => {
  try { return readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8').substring(0, 2000); }
  catch { return ''; }
})();

// ── Applicant Profile ──────────────────────────────────────────────────────────
export const PROFILE = {
  firstName: 'Abhishek Raj',
  lastName: 'Pagadala',
  fullName: 'Abhishek Raj Pagadala',
  email: process.env.APPLICANT_EMAIL || 'pagadalaabhishek60@gmail.com',
  phone: process.env.APPLICANT_PHONE || '+49 176 6723 9250',
  linkedin: 'https://www.linkedin.com/in/abhishek-raj-pagadala',
  github: 'https://github.com/AbhishekAbsy0710',
  city: 'Munich',
  country: 'Germany',
};

// ── Static Answer Cache — skips AI for common fields ──────────────────────────
export const STATIC_ANSWERS = [
  // Legal work authorisation MUST come first to prevent country pattern matching
  { patterns: [/legally auth/i, /authorised.*work/i, /authorized.*work/i], value: 'Yes, no restriction.', type: 'reactselect' },
  // LinkedIn
  { patterns: [/linkedin/i], value: PROFILE.linkedin, type: 'text' },
  // GitHub
  { patterns: [/github/i, /portfolio.*url/i], value: PROFILE.github, type: 'text' },
  // Website/Portfolio
  { patterns: [/website/i, /personal.*url/i, /your.*website/i], value: PROFILE.github, type: 'text' },
  // Location / city
  { patterns: [/^city$/i, /current.*city/i, /^location$/i, /where.*are.*you.*based/i, /city.*you.*live/i], value: PROFILE.city, type: 'text' },
  // Country
  { patterns: [/^country$/i, /country.*reside/i, /country.*live/i, /country.*located/i, /country.*currently/i, /country.*origin/i, /passport.*country/i, /country.*passport/i, /country.*citizenship/i, /nationality/i], value: PROFILE.country, type: 'text' },
  // Salary
  { patterns: [/salary.*expectation/i, /expected.*salary/i, /desired.*salary/i, /compensation/i], value: '55000', type: 'text' },
  // Notice period
  { patterns: [/notice.*period/i, /start.*date/i, /available.*start/i], value: 'Immediate', type: 'text' },
  // Preferred name
  { patterns: [/preferred.*name/i, /preferred first/i], value: 'Abhishek', type: 'text' },
  // Twitter/X
  { patterns: [/twitter/i, /\bx\.com\b/i, /x\s*\/\s*twitter/i, /twitter.*profile/i], value: 'https://x.com/AbhishekAbsy', type: 'text' },
  // Pronouns
  { patterns: [/pronoun/i], value: 'He/him', type: 'text' },
  // Visa sponsorship
  { patterns: [/\brequire.*visa\b/i, /\bneed.*visa.*sponsor/i, /\bvisa.*required\b/i], value: 'No', type: 'radio' },
  // Work authorization
  { patterns: [/work.*authoriz/i, /work.*permit/i, /right.*to.*work/i], value: 'Yes', type: 'radio' },
];

/**
 * Try to find a static answer for a field label.
 * @param {string} labelText - The label/question text
 * @returns {{ value: string, type: string } | null}
 */
export function tryStaticAnswer(labelText) {
  const label = (labelText || '').replace(/[*\u25cf\u2022\uFE0F]+/g, '').trim().toLowerCase();
  for (const rule of STATIC_ANSWERS) {
    if (rule.patterns.some(p => p.test(label))) {
      return { value: rule.value, type: rule.type };
    }
  }
  return null;
}

// ── Target Role Keywords ──────────────────────────────────────────────────────
export const TARGET_KEYWORDS = [
  'data engineer', 'data analyst', 'data scientist', 'analytics engineer',
  'devops', 'cloud engineer', 'cloud architect', 'platform engineer',
  'backend', 'fullstack', 'full stack', 'full-stack',
  'software engineer', 'software developer',
  'ai engineer', 'ml engineer', 'machine learning', 'mlops',
  'infrastructure engineer', 'site reliability', 'sre',
  'frontend engineer', 'frontend developer',
  'tech lead', 'lead engineer', 'staff engineer', 'principal engineer',
  'automation engineer', 'automation developer',
  'solutions architect', 'cloud consultant', 'devops consultant',
  'data platform', 'data infrastructure',
  'ki-agent', 'ki engineer',
  'security engineer', 'security analyst', 'cybersecurity', 'devsecops', 'appsec', 'cloud security',
  'it support', 'it specialist', 'systems engineer', 'systems administrator', 'sysadmin',
  'network engineer', 'network administrator', 'network architect',
];

// ── Skip Keywords (non-IT roles) ──────────────────────────────────────────────
export const SKIP_KEYWORDS = [
  // Trades / manual / non-tech (German)
  'kosmetik', 'werkstudent', 'praktikum', 'praktikant', 'pflege', 'fahrer',
  'tischler', 'maler', 'fotovoltaik', 'photovoltaik', 'elektriker',
  'reinigung', 'handwerk', 'schweißer', 'sanitär', 'lagerlogistik',
  'sozialarbeiter', 'krankenpflege', 'bürokaufmann', 'kaufmann',
  'steuerberater', 'buchhalter',
  // Marketing / social media
  'influencer', 'marketing manager', 'social media manager',
  'community manager', 'brand manager', 'seo manager',
  'performance marketing', 'campaign manager', 'content creator',
  'copywriter', 'redakteur', 'tiktok', 'reels', 'journalist',
  // Sales / BD
  'sales manager', 'sales representative', 'sales engineer',
  'account executive', 'account manager', 'business development',
  'customer success manager', 'partnership manager', 'revenue operations',
  // Non-IC management
  'engineering manager', 'vp of engineering', 'head of engineering',
  'director of engineering', 'chief technology officer',
  'tax lead', 'tax manager', 'tax consultant', 'finance manager',
  'hr manager', 'recruiter', 'talent acquisition', 'people operations',
  // Technical but out-of-scope
  'c++ developer', 'embedded', 'firmware', 'hardware engineer',
  'mechanical engineer', 'civil engineer', 'chemical engineer',
  'nurse', 'doctor', 'physician',
  'personalberater',
];

// ── Pipeline Constants ────────────────────────────────────────────────────────
export const MAX_JOBS_PER_RUN = 25;
export const MAX_PREFILTER_PER_COMPANY = 3;
export const MAX_PER_COMPANY = 2;
export const PAGE_LOAD_BLOCKED = ['adyen', 'cloudflare', 'stripe', 'planetscale', 'clickhouse'];

// ── Discord ────────────────────────────────────────────────────────────────────
export const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
