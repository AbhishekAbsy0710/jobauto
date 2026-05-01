import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const envPath = join(__dirname, '..', '.env');
  const env = {};

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex !== -1) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        env[key] = value;
        process.env[key] = process.env[key] || value;
      }
    }
  }

  return {
    port: parseInt(process.env.PORT || env.PORT || '3000'),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || 'llama3.1:8b',
    groqApiKey: process.env.GROQ_API_KEY || env.GROQ_API_KEY || '',
    supabaseUrl: process.env.SUPABASE_URL || env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY || '',
    jsearchApiKey: process.env.JSEARCH_API_KEY || env.JSEARCH_API_KEY || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || '',
    applicantEmail: process.env.APPLICANT_EMAIL || env.APPLICANT_EMAIL || '',
    applicantPhone: process.env.APPLICANT_PHONE || env.APPLICANT_PHONE || '',
    autoApplyMode: process.env.AUTO_APPLY_MODE || env.AUTO_APPLY_MODE || 'approval',
    searchKeywords: (process.env.SEARCH_KEYWORDS || env.SEARCH_KEYWORDS || 'DevOps Engineer,Cloud Engineer,Full Stack Developer,Data Engineer,AI Engineer').split(',').map(s => s.trim()),
    searchLocations: (process.env.SEARCH_LOCATIONS || env.SEARCH_LOCATIONS || 'Switzerland,Germany,Luxembourg,Netherlands,Austria,Belgium,France,Remote').split(',').map(s => s.trim()),
  };
}

export function loadProfile() {
  const profilePath = join(__dirname, '..', 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    console.log('⚠️  No config/profile.yml found — using defaults');
    return getDefaultProfile();
  }
  try {
    const content = readFileSync(profilePath, 'utf-8');
    return yaml.load(content);
  } catch (e) {
    console.error('❌ Failed to parse profile.yml:', e.message);
    return getDefaultProfile();
  }
}

export function loadPortals() {
  const portalsPath = join(__dirname, '..', 'config', 'portals.yml');
  if (!existsSync(portalsPath)) return { greenhouse: [], lever: [], ashby: [], filter_keywords: [] };
  try {
    const content = readFileSync(portalsPath, 'utf-8');
    return yaml.load(content);
  } catch (e) {
    console.error('❌ Failed to parse portals.yml:', e.message);
    return { greenhouse: [], lever: [], ashby: [], filter_keywords: [] };
  }
}

export function loadCV() {
  const cvPath = join(__dirname, '..', 'resume', 'cv.md');
  const txtPath = join(__dirname, '..', 'resume', 'resume.txt');
  if (existsSync(cvPath)) return readFileSync(cvPath, 'utf-8');
  if (existsSync(txtPath)) return readFileSync(txtPath, 'utf-8');
  return '';
}

function getDefaultProfile() {
  return {
    identity: { name: 'User', location: 'Remote' },
    target_roles: ['Software Engineer'],
    target_locations: ['Remote'],
    scoring_weights: {
      technical_fit: 0.20, seniority_alignment: 0.15, domain_relevance: 0.15,
      growth_potential: 0.10, company_signal: 0.10, compensation_fit: 0.10,
      location_remote: 0.05, cultural_indicators: 0.05, tech_stack_freshness: 0.05,
      visa_sponsorship: 0.05
    },
    deal_breakers: [],
    archetypes: {}
  };
}
