/**
 * agents/constants.js — Shared Configuration & Constants
 * 
 * Centralized profile data, static answer cache, keyword lists, 
 * selector constants, and pipeline configuration.
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
  confirmEmail: process.env.APPLICANT_EMAIL || 'pagadalaabhishek60@gmail.com',
  phone: process.env.APPLICANT_PHONE || '+49 176 6723 9250',
  linkedin: 'https://www.linkedin.com/in/abhishek-raj-pagadala',
  github: 'https://github.com/AbhishekAbsy0710',
  city: 'Munich',
  country: 'Germany',
};

// ── Static Answer Cache — skips Groq for common fields ──────────────────────
export const STATIC_ANSWERS = [
  // Legal work authorisation MUST come first to prevent country pattern matching "in the country where..."
  { patterns: [/legally auth/i, /authorised.*work/i, /authorized.*work/i], value: 'Yes, no restriction.', type: 'reactselect' },
  // Confirm email (SmartRecruiters requires this)
  { patterns: [/confirm.*email/i, /re-?enter.*email/i, /email.*confirm/i, /verify.*email/i], value: 'pagadalaabhishek60@gmail.com', type: 'text' },
  // LinkedIn
  { patterns: [/linkedin/i], value: PROFILE.linkedin, type: 'text' },
  // GitHub
  { patterns: [/github/i, /portfolio.*url/i], value: PROFILE.github, type: 'text' },
  // Website/Portfolio (generic)
  { patterns: [/website/i, /personal.*url/i, /your.*website/i], value: PROFILE.github, type: 'text' },
  // Location / city — ONLY match simple "city" labels, NOT "location(s) to work" dropdowns
  { patterns: [/^city$/i, /current.*city/i, /^location$/i, /where.*are.*you.*based/i, /city.*you.*live/i], value: PROFILE.city, type: 'text' },
  // Country — matches all country variants including Passport Country and Country of Residence
  { patterns: [/^country$/i, /country.*reside/i, /country.*live/i, /country.*located/i, /country.*currently/i, /country.*origin/i, /passport.*country/i, /country.*passport/i, /country.*citizenship/i, /nationality/i], value: PROFILE.country, type: 'text' },
  // Salary
  { patterns: [/salary.*expectation/i, /expected.*salary/i, /desired.*salary/i, /compensation/i], value: '55000', type: 'text' },
  // Notice period
  { patterns: [/notice.*period/i, /start.*date/i, /available.*start/i], value: 'Immediate', type: 'text' },
  // Preferred name
  { patterns: [/preferred.*name/i, /preferred first/i], value: 'Abhishek', type: 'text' },
  // Twitter/X profile
  { patterns: [/twitter/i, /\bx\.com\b/i, /x\s*\/\s*twitter/i, /twitter.*profile/i], value: 'https://x.com/AbhishekAbsy', type: 'text' },
  // Pronouns
  { patterns: [/pronoun/i], value: 'He/him', type: 'text' },
  // Visa sponsorship (plain radio/select)
  { patterns: [/\brequire.*visa\b/i, /\bneed.*visa.*sponsor/i, /\bvisa.*required\b/i], value: 'No', type: 'radio' },
  // Work authorization (plain text/radio)
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

// ── Submit Button Selectors (ordered by specificity) ──────────────────────────
export const SUBMIT_SELECTORS = [
  // Generic
  'button[type="submit"]',
  'input[type="submit"]',
  // SmartRecruiters
  'button[data-qa="btn-apply"]',
  'button[data-qa="action-button"]',
  'button[class*="wds-button"][class*="primary"]',
  'button:has-text("Submit Application")',
  'button:has-text("Submit application")',
  'button:has-text("Send application")',
  // Ashby
  'button[data-testid="ashby-btn-primary"]',
  '.ashby-application-form-submit-button',
  // Greenhouse
  '#submit_app', '#submit-app',
  'button#submit_app',
  'input#submit_app',
  // Lever
  'button.postings-btn.template-btn-submit',
  'a.postings-btn',
  // Generic text
  'button:has-text("Submit")',
  'button:has-text("Apply")',
  'button:has-text("Apply Now")',
  'button:has-text("Send Application")',
  'button:has-text("Send your application")',
  'button:has-text("Bewerbung absenden")',
  'button:has-text("Jetzt bewerben")',
  // Workday
  'button[data-automation-id="bottom-navigation-next-button"]',
  'button[data-automation-id="bottom-navigation-review-btn"]',
  // Teamtailor (Spotify)
  'button[data-testid="submit-button"]',
  'button.button--primary:has-text("Send application")',
  'button.button--primary:has-text("Apply")',
  // Misc
  'button.submit-application',
  '[data-action="submit"]',
  'button[aria-label*="submit" i]',
  'button[aria-label*="apply" i]',
];

// ── Next/Continue Button Selectors ────────────────────────────────────────────
export const NEXT_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Weiter")',
  'button:has-text("Next Step")',
  'button:has-text("Next Page")',
  'button:has-text("Review")',
  // SmartRecruiters specific
  'button[data-qa="action-button"]',
  'button[class*="wds-button"]',
  'button:has-text("Start Application")',
  'button:has-text("Start application")',
  'button:has-text("I understand")',
  '[data-qa="btn-continue"]',
  // Workday / generic
  'button[data-testid="next-button"]',
  'button[data-testid="continue"]',
  'button[data-automation-id="bottom-navigation-next-button"]',
  'a:has-text("Next")',
  'a:has-text("Continue")',
  '.next-btn', '#next-button',
  'button[aria-label*="next" i]',
];

// ── Final Page Detection Signals ──────────────────────────────────────────────
export const FINAL_PAGE_SIGNALS = [
  'review your application', 'review and submit', 'überprüfen', 'zusammenfassung'
];

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
export const MAX_STEPS = 10;
export const PAGE_LOAD_BLOCKED = ['adyen', 'cloudflare', 'stripe', 'planetscale', 'clickhouse'];

// ── Discord (lazy — must read at call-time because .env loads after ESM imports) ──
export function getDiscordWebhook() { return process.env.DISCORD_WEBHOOK_URL || ''; }
// Deprecated: do NOT use DISCORD_WEBHOOK (empty at import-time in local runs)
export const DISCORD_WEBHOOK = '';
