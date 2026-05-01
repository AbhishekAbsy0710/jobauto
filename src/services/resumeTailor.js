// Uses native fetch (Node 18+)
import { loadConfig, loadCV } from '../config.js';

/**
 * Resume Tailoring Engine.
 * Uses Ollama to rewrite 3-5 bullet points from the CV
 * to match the specific job description.
 * NEVER fabricates skills — only reframes existing experience.
 */
export async function tailorResume(job, evaluation) {
  const config = loadConfig();
  const cvContent = loadCV();

  if (!cvContent) throw new Error('No CV found');

  const matchingSkills = evaluation?.matching_skills || [];
  const missingSkills = evaluation?.missing_skills || [];
  const improvements = evaluation?.resume_improvements || [];

  const prompt = `You are a resume optimization expert. Your task is to rewrite 3-5 bullet points from the candidate's CV to better match the target job description.

RULES:
- ONLY reframe existing experience — NEVER add skills or experience the candidate doesn't have
- Keep the same facts, quantified metrics, and outcomes — just adjust emphasis and wording
- Use strong action verbs and quantify impact where possible
- Target ATS keyword matching for the job description
- Output ONLY a JSON array of objects with "original" and "tailored" fields

CANDIDATE'S CV:
${cvContent.slice(0, 3000)}

TARGET JOB:
- Title: ${job.title}
- Company: ${job.company}
- Description: ${(job.description || '').slice(0, 2000)}

MATCHING SKILLS: ${matchingSkills.join(', ')}
SKILL GAPS: ${missingSkills.join(', ')}
SUGGESTED IMPROVEMENTS: ${improvements.join('; ')}

Return ONLY valid JSON array:
[
  { "original": "exact original bullet text", "tailored": "optimized bullet text", "section": "experience section name" },
  ...
]`;

  try {
    const url = `${config.ollamaBaseUrl}/api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 2000 }
      }),
      signal: AbortSignal.timeout(300000)
    });

    if (!response.ok) throw new Error(`Ollama ${response.status}`);
    const data = await response.json();
    const raw = data.message?.content || '';

    // Parse result
    let jsonStr = raw.trim();
    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) jsonStr = match[1].trim();

    const result = JSON.parse(jsonStr);
    const bullets = Array.isArray(result) ? result : (result.bullets || result.tailored || []);

    console.log(`  ✏️ Tailored ${bullets.length} bullets for ${job.company}`);
    return bullets;
  } catch (error) {
    console.error(`  ⚠️ Resume tailor failed: ${error.message}`);
    return []; // Fallback: use original CV as-is
  }
}

/**
 * Apply tailored bullets to the CV content.
 * Returns the modified CV markdown.
 */
export function applyTailoredBullets(cvContent, bullets) {
  if (!bullets || bullets.length === 0) return cvContent;

  let modified = cvContent;
  for (const bullet of bullets) {
    if (bullet.original && bullet.tailored) {
      // Try exact replacement first
      if (modified.includes(bullet.original)) {
        modified = modified.replace(bullet.original, bullet.tailored);
      }
    }
  }

  // If no replacements matched, prepend as "Tailored Highlights"
  if (modified === cvContent && bullets.length > 0) {
    const highlights = bullets
      .filter(b => b.tailored)
      .map(b => `- ${b.tailored}`)
      .join('\n');

    if (highlights) {
      modified = cvContent.replace(
        /^(# .+\n)/,
        `$1\n## Tailored Highlights\n\n${highlights}\n\n---\n`
      );
    }
  }

  return modified;
}
