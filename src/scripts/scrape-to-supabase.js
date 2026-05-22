#!/usr/bin/env node
/**
 * scrape-to-supabase.js
 * Runs all job scrapers and upserts results directly into Supabase.
 * Designed to run in GitHub Actions before the apply pipeline.
 */

import { createClient } from '@supabase/supabase-js';
import { scrapeArbeitnow } from '../scrapers/arbeitnow.js';
import { scrapeRemoteOK } from '../scrapers/remoteok.js';
import { scanPortals } from '../scrapers/portals.js';
import { scrapeLinkedIn } from '../scrapers/linkedin.js';
import { scrapeIndeed } from '../scrapers/indeed.js';
import { scrapeStepStone } from '../scrapers/stepstone.js';
import { scrapeLuxembourg } from '../scrapers/luxembourg.js';
import { scrapeSmartRecruiters } from '../scrapers/smartrecruiters.js';
import { loadConfig, loadPortals } from '../config.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ── Groq evaluator ────────────────────────────────────────────────────────────
async function evaluateJob(job, profileText) {
  // Try Gemini first (free, 1500 req/day, richer output), fallback to Groq
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  const richPrompt = `You are an expert ATS job-fit evaluator. Analyze the candidate profile against the job description.
Return ONLY valid JSON in this EXACT shape (no markdown, no explanation):
{
  "score": <0-100 integer>,
  "grade": "<A|B|C|D|F>",
  "action": "<auto_queue|manual_queue|skip>",
  "reason": "<2-3 sentence assessment>",
  "archetype": "<one of: Backend|Frontend|Fullstack|DevOps|Cloud|Data|AI|Mobile|Security|Other>",
  "risk_level": "<low|medium|high>",
  "priority": "<high|medium|low>",
  "matching_skills": ["skill1","skill2","skill3","skill4","skill5"],
  "missing_skills": ["skill1","skill2"],
  "dimension_scores": {
    "technical_skills": {"grade":"<A-F>","reason":"<1 sentence>"},
    "experience_level": {"grade":"<A-F>","reason":"<1 sentence>"},
    "education_fit": {"grade":"<A-F>","reason":"<1 sentence>"},
    "location_match": {"grade":"<A-F>","reason":"<1 sentence>"},
    "culture_fit": {"grade":"<A-F>","reason":"<1 sentence>"},
    "communication": {"grade":"<A-F>","reason":"<1 sentence>"},
    "leadership": {"grade":"<A-F>","reason":"<1 sentence>"},
    "domain_knowledge": {"grade":"<A-F>","reason":"<1 sentence>"}
  },
  "resume_improvements": ["improvement1","improvement2","improvement3"],
  "star_stories": [{"situation":"<context>","task":"<challenge>","action":"<what to do>","result":"<expected outcome>"}]
}

Grading rules:
- A (85-100): Strong match, 80%+ skills match, relevant experience
- B (70-84): Good match, 60%+ skills match
- C (50-69): Partial match, some transferable skills
- D (30-49): Weak match, significant gaps
- F (0-29): No match

action rules: A/B → "auto_queue", C → "manual_queue", D/F → "skip"`;

  const userMsg = `CANDIDATE PROFILE:\n${profileText}\n\nJOB TITLE: ${job.title}\nCOMPANY: ${job.company}\nLOCATION: ${job.location}\nDESCRIPTION:\n${(job.description || '').slice(0, 2500)}`;

  // --- Try Gemini first ---
  if (geminiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: richPrompt + '\n\n' + userMsg }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1200, responseMimeType: 'application/json' }
          })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          parsed._model = 'gemini-2.0-flash';
          parsed.dimension_scores = normalizeDimensions(parsed.dimension_scores);
          return parsed;
        }
      }
    } catch { /* fall through to Groq */ }
  }

  // --- Fallback: Groq/Llama ---
  if (groqKey) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.1,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: richPrompt },
            { role: 'user', content: userMsg }
          ]
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          parsed._model = 'llama-3.1-8b';
          parsed.dimension_scores = normalizeDimensions(parsed.dimension_scores);
          return parsed;
        }
      }
    } catch { /* fall through to Grok */ }
  }

  // --- Fallback: Grok (xAI, $25 free credits) ---
  const grokKey = process.env.GROK_API_KEY;
  if (grokKey) {
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grokKey}` },
        body: JSON.stringify({
          model: 'grok-3-mini-fast',
          temperature: 0.1,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: richPrompt },
            { role: 'user', content: userMsg }
          ]
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          parsed._model = 'grok-3-mini-fast';
          parsed.dimension_scores = normalizeDimensions(parsed.dimension_scores);
          return parsed;
        }
      }
    } catch { /* no more fallbacks */ }
  }

  return null;
}

// Normalize dimension_scores: Groq may return numbers (90), Gemini returns {grade, reason}
function normalizeDimensions(dims) {
  if (!dims || typeof dims !== 'object') return {};
  const result = {};
  for (const [key, val] of Object.entries(dims)) {
    if (typeof val === 'number') {
      const g = val >= 85 ? 'A' : val >= 70 ? 'B' : val >= 50 ? 'C' : val >= 30 ? 'D' : 'F';
      result[key] = { grade: g, reason: `Score: ${val}/100` };
    } else if (typeof val === 'object' && val.grade) {
      result[key] = val;
    } else if (typeof val === 'string') {
      result[key] = { grade: val, reason: '' };
    } else {
      result[key] = { grade: 'C', reason: 'Unknown' };
    }
  }
  return result;
}

// ── Deal-breaker check ────────────────────────────────────────────────────────
function isDealBreaker(job, dealBreakers = []) {
  const text = `${job.title} ${job.description} ${job.location}`.toLowerCase();
  for (const db of dealBreakers) {
    if (text.includes(db.toLowerCase())) return true;
  }
  // Hard-coded universal deal-breakers
  const hard = ['no remote', 'on-site only', 'must relocate', 'security clearance required',
    'us citizen only', 'active clearance', 'require authorization'];
  return hard.some(h => text.includes(h));
}

// ── Upsert job + optional evaluation into Supabase ───────────────────────────
async function upsertJob(job, evaluation) {
  // EXCEPTION: Some ATS platforms always trigger hCaptcha on form submit,
  // or are blocked by Cloudflare Bot Management on GHA datacenter IPs.
  // Route them to manual_queue at scrape time to avoid wasting browser time.
  //
  //   - greenhouse: job-boards.greenhouse.io is behind Cloudflare — GHA IPs blocked 100%
  //   - ashby: all companies trigger hCaptcha on form submit
  //   - lever: Spotify confirmed; likely all Lever companies trigger hCaptcha
  const CAPTCHA_PLATFORMS = ['ashby', 'lever', 'greenhouse'];
  // Companies whose apply pages block GHA IPs (Cloudflare bot protection on custom career sites)
  const PAGE_LOAD_BLOCKED_COMPANIES = ['bitpanda', 'showpad', 'cockroach labs', 'cockroachlabs'];
  const platformLower = (job.platform || '').toLowerCase();
  const companyLower = (job.company || '').toLowerCase();
  // Also check apply_link directly — some jobs have platform='unknown' but link to greenhouse
  const applyLinkLower = (job.apply_link || '').toLowerCase();
  const isGreenhouseLink = applyLinkLower.includes('greenhouse.io') || applyLinkLower.includes('job-boards.greenhouse');
  const status = CAPTCHA_PLATFORMS.includes(platformLower) || PAGE_LOAD_BLOCKED_COMPANIES.some(c => companyLower.includes(c)) || isGreenhouseLink
    ? 'manual_queue'                          // Cloudflare/hCaptcha blocked → manual
    : (evaluation?.action || 'new');          // No evaluation (rate-limited) → stay 'new' until evaluated

  // Only include columns that exist in the Supabase jobs table schema:
  // id, title, company, location, description, apply_link, platform,
  // remote, tags, status, source_id, scraped_at, updated_at, proof_url,
  // tailored_resume_url, applied_at
  const jobRow = {
    source_id: job.external_id,          // unique identifier per scraper
    title: job.title,
    company: job.company || '',
    platform: job.platform || 'unknown',
    apply_link: job.apply_link || '',
    description: (job.description || '').slice(0, 8000),
    location: job.location || '',
    tags: Array.isArray(job.tags) ? job.tags.filter(Boolean) : [],
    remote: job.remote ?? false,
    status,
    scraped_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabase
    .from('jobs')
    .upsert(jobRow, { onConflict: 'source_id', ignoreDuplicates: false })
    .select('id')
    .single();

  if (error) {
    if (!error.message?.includes('duplicate') && !error.code?.includes('23505')) {
      console.error(`  ❌ Upsert error (${job.title}): ${error.message}`);
    }
    return null;
  }

  // Insert evaluation if we have one (evaluations table real columns:
  // id, job_id, letter_grade, weighted_score, match_percentage, archetype,
  // action, priority, risk_level, reason, matching_skills, missing_skills,
  // resume_improvements, dimension_scores, star_stories, evaluated_at)
  if (evaluation && inserted?.id) {
    try {
      await supabase.from('evaluations').insert({
        job_id: inserted.id,
        letter_grade: evaluation.grade,
        weighted_score: evaluation.score / 10,
        match_percentage: evaluation.score,
        action: evaluation.action,
        priority: evaluation.priority || (evaluation.grade === 'A' ? 'high' : evaluation.grade === 'B' ? 'medium' : 'low'),
        risk_level: evaluation.risk_level || 'low',
        reason: evaluation.reason,
        archetype: evaluation.archetype || 'Other',
        matching_skills: evaluation.matching_skills || [],
        missing_skills: evaluation.missing_skills || [],
        resume_improvements: evaluation.resume_improvements || [],
        dimension_scores: evaluation.dimension_scores || {},
        star_stories: evaluation.star_stories || [],
        evaluated_at: new Date().toISOString(),
      });
    } catch { /* ignore duplicate inserts */ }
  }

  return inserted?.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const portals = loadPortals();
  const keywords = config.searchKeywords;
  const locations = config.searchLocations;
  const portalKeywords = portals.filter_keywords || keywords;
  const dealBreakers = portals.deal_breakers || [];

  // Basic profile text for quick scoring
  const profileText = `
Target roles: ${keywords.join(', ')}
Target locations: ${locations.join(', ')}
Key skills: DevOps, Cloud (AWS/GCP/Azure), Kubernetes, Terraform, CI/CD, Python, TypeScript, Docker, PostgreSQL, Infrastructure as Code, Platform Engineering
Experience: 3-5 years
Preferred: Remote-first, EU-based companies, startup/scale-up
Deal breakers: ${dealBreakers.join(', ')}
  `.trim();

  const srCompanies = portals.smartrecruiters || [];

  console.log('\n🚀 JobAuto — Scrape to Supabase');
  console.log(`   Sources: ArbeitNow, RemoteOK, SmartRecruiters (${srCompanies.length} companies), Portals (Greenhouse/Lever/Ashby), LinkedIn, Indeed, StepStone, Luxembourg`);
  console.log(`   Keywords: ${keywords.slice(0, 4).join(', ')}...`);
  console.log(`   Locations: ${locations.slice(0, 4).join(', ')}...`);
  console.log('');

  const results = { total: 0, new: 0, skipped: 0, errors: 0 };

  // ── Batch 1: Fast APIs ────────────────────────────────────────────────────
  const [arbeitnowRes, remoteOkRes, portalsRes, smartrecruitersRes] = await Promise.allSettled([
    scrapeArbeitnow(keywords, locations),
    scrapeRemoteOK(keywords),
    scanPortals(portalKeywords),
    scrapeSmartRecruiters(srCompanies),
  ]);

  // ── Batch 2: Web scrapers (with error tolerance) ──────────────────────────
  const [linkedinRes, indeedRes, stepstoneRes, luxembourgRes] = await Promise.allSettled([
    scrapeLinkedIn().catch(e => { console.log(`  ⚠️  LinkedIn: ${e.message}`); return []; }),
    scrapeIndeed().catch(e => { console.log(`  ⚠️  Indeed: ${e.message}`); return []; }),
    scrapeStepStone().catch(e => { console.log(`  ⚠️  StepStone: ${e.message}`); return []; }),
    scrapeLuxembourg().catch(e => { console.log(`  ⚠️  Luxembourg: ${e.message}`); return []; }),
  ]);

  const allJobs = [
    ...(arbeitnowRes.status === 'fulfilled' ? arbeitnowRes.value : []),
    ...(remoteOkRes.status === 'fulfilled' ? remoteOkRes.value : []),
    ...(portalsRes.status === 'fulfilled' ? portalsRes.value : []),
    ...(smartrecruitersRes.status === 'fulfilled' ? smartrecruitersRes.value : []),
    ...(linkedinRes.status === 'fulfilled' ? linkedinRes.value : []),
    ...(indeedRes.status === 'fulfilled' ? indeedRes.value : []),
    ...(stepstoneRes.status === 'fulfilled' ? stepstoneRes.value : []),
    ...(luxembourgRes.status === 'fulfilled' ? luxembourgRes.value : []),
  ];

  console.log(`\n📋 Total scraped: ${allJobs.length} jobs — now evaluating & upserting...\n`);
  results.total = allJobs.length;

  // Process in batches of 5 to avoid rate limiting Groq
  const BATCH = 5;
  for (let i = 0; i < allJobs.length; i += BATCH) {
    const batch = allJobs.slice(i, i + BATCH);

    await Promise.all(batch.map(async (job) => {
      try {
        // Skip deal-breakers immediately
        if (isDealBreaker(job, dealBreakers)) {
          results.skipped++;
          return;
        }

        // Quick AI evaluation
        const eval_ = await evaluateJob(job, profileText);

        // Skip low-score jobs (grade D or score < 40)
        if (eval_ && (eval_.grade === 'D' || eval_.score < 40)) {
          results.skipped++;
          return;
        }

        const id = await upsertJob(job, eval_);
        if (id) {
          results.new++;
          const grade = eval_ ? `[${eval_.grade}:${eval_.score}]` : '[?]';
          console.log(`  ✅ ${grade} ${job.title} @ ${job.company}`);
        }
      } catch (e) {
        results.errors++;
        console.error(`  ❌ ${job.title}: ${e.message}`);
      }
    }));

    // Polite pause between batches
    if (i + BATCH < allJobs.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n📊 Scrape Summary:');
  console.log(`   Total found:  ${results.total}`);
  console.log(`   Upserted:     ${results.new}`);
  console.log(`   Skipped:      ${results.skipped} (low score / deal-breaker)`);
  console.log(`   Errors:       ${results.errors}`);
  console.log('');

  // Promote 'new' jobs that HAVE evaluations → auto_queue
  // (never promote jobs without evaluations to avoid ? scores)
  const { data: evaledNew } = await supabase
    .from('evaluations')
    .select('job_id')
    .not('job_id', 'is', null);
  const evaledJobIds = (evaledNew || []).map(e => e.job_id);

  if (evaledJobIds.length > 0) {
    const { data: promoted, error: promErr } = await supabase
      .from('jobs')
      .update({ status: 'auto_queue', updated_at: new Date().toISOString() })
      .eq('status', 'new')
      .in('id', evaledJobIds)
      .select('id');
    if (!promErr && promoted?.length > 0) {
      console.log(`   ♻️  Promoted ${promoted.length} evaluated 'new' jobs → auto_queue`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
