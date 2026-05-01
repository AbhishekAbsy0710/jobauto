// Vercel Cron: /api/cron/evaluate — runs 30 min after scrape
// Evaluates unevaluated jobs using Groq API
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

async function callGroq(systemPrompt, userPrompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const GRADE_VALUES = { A: 5, B: 4, C: 3, D: 2, F: 0 };
const GRADE_FROM_SCORE = (s) => s >= 4.5 ? 'A' : s >= 3.5 ? 'B' : s >= 2.5 ? 'C' : s >= 1.5 ? 'D' : 'F';

const EU_LOCATIONS = [
  'switzerland', 'zurich', 'zürich', 'bern', 'geneva', 'basel', 'lausanne',
  'germany', 'berlin', 'munich', 'münchen', 'frankfurt', 'hamburg', 'cologne', 'düsseldorf', 'stuttgart',
  'luxembourg', 'netherlands', 'amsterdam', 'rotterdam', 'austria', 'vienna',
  'belgium', 'brussels', 'france', 'paris', 'europe', 'eu', 'emea', 'dach', 'remote',
  'ireland', 'dublin', 'uk', 'london', 'sweden', 'stockholm', 'denmark', 'copenhagen',
  'norway', 'oslo', 'finland', 'helsinki', 'poland', 'warsaw', 'czech', 'prague',
  'spain', 'madrid', 'barcelona', 'portugal', 'lisbon', 'italy', 'milan',
];

const NON_EU = [
  'united states', 'usa', 'california', 'new york', 'san francisco', 'seattle',
  'canada', 'toronto', 'vancouver', 'india', 'bangalore', 'hyderabad',
  'singapore', 'japan', 'tokyo', 'china', 'beijing', 'brazil', 'australia', 'sydney',
];

export default async function handler(req, res) {
  if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: 'No GROQ_API_KEY' });

  console.log('🤖 Cron evaluate starting...');
  const sb = getSupabase();

  // Get unevaluated jobs (left join to find ones without evaluations)
  const { data: allJobs } = await sb.from('jobs').select('*, evaluations(id)').eq('status', 'new').limit(20);
  const unevaluated = (allJobs || []).filter(j => !j.evaluations || j.evaluations.length === 0);

  console.log(`📋 ${unevaluated.length} jobs to evaluate`);

  let evaluated = 0;
  let errors = 0;

  const systemPrompt = `You are a Career-Ops Job Evaluation Agent. Evaluate job listings using A-F scoring across 10 dimensions.
OUTPUT ONLY JSON: {"archetype":"DevOps|Cloud|Data|AI|FullStack|Other","dimension_scores":{"technical_fit":{"grade":"A-F","reason":"brief"},"seniority_alignment":{"grade":"A-F","reason":"brief"},"domain_relevance":{"grade":"A-F","reason":"brief"},"growth_potential":{"grade":"A-F","reason":"brief"},"company_signal":{"grade":"A-F","reason":"brief"},"compensation_fit":{"grade":"A-F","reason":"brief"},"location_remote":{"grade":"A-F","reason":"brief"},"cultural_indicators":{"grade":"A-F","reason":"brief"},"tech_stack_freshness":{"grade":"A-F","reason":"brief"},"visa_sponsorship":{"grade":"A-F","reason":"brief"}},"matching_skills":["skill"],"missing_skills":["skill"],"resume_improvements":["suggestion"],"star_stories":[{"situation":"...","task":"...","action":"...","result":"..."}],"reason":"summary"}`;

  for (const job of unevaluated) {
    try {
      // EU gate check
      const loc = (job.location || '').toLowerCase();
      const isEU = EU_LOCATIONS.some(k => loc.includes(k));
      const isNonEU = NON_EU.some(k => loc.includes(k));

      if (isNonEU && !isEU) {
        // Skip non-EU
        await sb.from('evaluations').insert({
          job_id: job.id,
          letter_grade: 'F', weighted_score: 0, match_percentage: 0,
          action: 'Skip', priority: 'Low', risk_level: 'Low',
          reason: `Non-EU location: ${job.location}`,
          archetype: 'Other',
        });
        await sb.from('jobs').update({ status: 'archived' }).eq('id', job.id);
        evaluated++;
        continue;
      }

      const userPrompt = `JOB: ${job.title} at ${job.company} (${job.platform})\nLocation: ${job.location || 'N/A'}\nDescription:\n${(job.description || '').slice(0, 1500)}\n\nReturn ONLY JSON.`;

      const raw = await callGroq(systemPrompt, userPrompt);
      const result = JSON.parse(raw);

      // Calculate weighted score
      const dims = result.dimension_scores || {};
      const weights = { technical_fit: 0.20, seniority_alignment: 0.15, domain_relevance: 0.15, growth_potential: 0.10, company_signal: 0.10, compensation_fit: 0.10, location_remote: 0.05, cultural_indicators: 0.05, tech_stack_freshness: 0.05, visa_sponsorship: 0.05 };
      let sum = 0, totalW = 0;
      for (const [key, w] of Object.entries(weights)) {
        const grade = dims[key]?.grade || 'C';
        sum += (GRADE_VALUES[grade] ?? 3) * w;
        totalW += w;
      }
      const score = totalW > 0 ? Math.round((sum / totalW) * 100) / 100 : 0;
      const letterGrade = GRADE_FROM_SCORE(score);
      const action = score >= 3.5 ? 'Apply' : score >= 2.5 ? 'Review' : 'Skip';
      const status = action === 'Apply' ? 'auto_queue' : action === 'Review' ? 'manual_queue' : 'archived';

      await sb.from('evaluations').insert({
        job_id: job.id,
        letter_grade: letterGrade,
        weighted_score: score,
        match_percentage: Math.round((score / 5) * 100),
        archetype: result.archetype || 'Other',
        action,
        priority: letterGrade === 'A' ? 'Critical' : letterGrade === 'B' ? 'High' : 'Medium',
        risk_level: 'Low',
        reason: result.reason || '',
        matching_skills: result.matching_skills || [],
        missing_skills: result.missing_skills || [],
        resume_improvements: result.resume_improvements || [],
        dimension_scores: result.dimension_scores || {},
        star_stories: result.star_stories || [],
      });

      await sb.from('jobs').update({ status }).eq('id', job.id);
      evaluated++;
      console.log(`  ✅ ${job.title} → ${letterGrade} (${score})`);

      // Rate limit: 30 req/min for Groq
      await new Promise(r => setTimeout(r, 2200));
    } catch (e) {
      console.error(`  ❌ ${job.title}: ${e.message}`);
      errors++;
    }
  }

  const result = { evaluated, errors, total: unevaluated.length, timestamp: new Date().toISOString() };
  console.log('✅ Evaluate complete:', result);

  // Discord notification
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (webhook && evaluated > 0) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'JobAuto',
        embeds: [{
          title: '🤖 Evaluation Complete',
          color: 0x00d2a0,
          description: `Evaluated **${evaluated}** jobs using Groq llama-3.3-70b`,
          timestamp: new Date().toISOString(),
        }],
      }),
    }).catch(() => {});
  }

  res.json(result);
}
