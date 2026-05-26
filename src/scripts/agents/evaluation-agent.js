/**
 * agents/evaluation-agent.js — Pre-Apply Job Evaluator
 * 
 * Scores job-profile fit BEFORE spending time on form filling.
 * Inspired by career-ops' A-F scoring dimensions.
 * Uses cheap Groq model for fast evaluation (~200 tokens).
 * 
 * Flow:
 *   1. Quick keyword check (zero-token)
 *   2. If borderline, LLM evaluation for deeper scoring
 * 
 * Exports:
 *   - evaluateJobFit(job) → { score: 1-5, grade: 'A'-'F', recommendation: 'apply'|'skip', reasons: string[] }
 */

import { callGroq } from './llm-client.js';
import { PROFILE_YAML, TARGET_KEYWORDS, SKIP_KEYWORDS } from './constants.js';

/**
 * Evaluate whether a job is worth applying to.
 * @param {object} job - Job object with title, company, description
 * @returns {{ score: number, grade: string, recommendation: string, reasons: string[] }}
 */
export async function evaluateJobFit(job) {
  const titleLower = (job.title || '').toLowerCase();
  const descLower = (job.description || '').toLowerCase();

  // ── Stage 1: Zero-token keyword filter ──
  // Hard skip: matches skip keywords
  for (const kw of SKIP_KEYWORDS) {
    if (titleLower.includes(kw.toLowerCase())) {
      return { score: 0, grade: 'F', recommendation: 'skip', reasons: [`Title matches skip keyword: "${kw}"`] };
    }
  }

  // Hard pass: matches target keywords → proceed to form (skip expensive LLM eval)
  const matchedTarget = TARGET_KEYWORDS.find(kw => titleLower.includes(kw.toLowerCase()));
  if (matchedTarget) {
    // Check for seniority mismatch (VP, Director, Head of, CTO — too senior)
    const senioritySkip = /\b(vp|vice president|director|head of|chief|principal|staff)\b/i;
    if (senioritySkip.test(titleLower)) {
      return { score: 2, grade: 'D', recommendation: 'skip', reasons: [`Seniority too high: "${job.title}"`] };
    }
    return { score: 4, grade: 'B', recommendation: 'apply', reasons: [`Target keyword match: "${matchedTarget}"`] };
  }

  // ── Stage 2: LLM evaluation for ambiguous titles ──
  // Only reached for titles that don't match target or skip keywords
  const sysPrompt = `You evaluate job-candidate fit. Return ONLY valid JSON, no markdown.`;
  const userPrompt = `Score this job fit (1-5):

Job: "${job.title}" at "${job.company}"
Description (first 400 chars): ${(job.description || 'N/A').substring(0, 400)}

Candidate summary: Full-stack engineer with 4+ years in DevOps, cloud infrastructure (Azure), AI/ML integration. MSc in Data Analytics. Based in Germany with EU Blue Card. Target: Data Engineer, DevOps, Cloud, Full-Stack, AI/ML roles.

Return JSON: {"score": <1-5>, "grade": "<A-F>", "recommendation": "<apply|skip>", "reasons": ["<reason1>", "<reason2>"]}

Scoring: 5=perfect fit, 4=strong fit, 3=moderate, 2=weak, 1=no fit. Recommend "apply" if score>=3.`;

  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) {
      console.log('  ⚠️ Evaluation: no JSON in response, defaulting to apply');
      return { score: 3, grade: 'C', recommendation: 'apply', reasons: ['Evaluation parse failed — defaulting to apply'] };
    }
    const parsed = JSON.parse(match[0]);
    // Sanitize
    parsed.score = Math.max(1, Math.min(5, parsed.score || 3));
    parsed.grade = ['F', 'D', 'C', 'B', 'A'][Math.min(4, Math.max(0, parsed.score - 1))];
    parsed.recommendation = parsed.score >= 3 ? 'apply' : 'skip';
    parsed.reasons = Array.isArray(parsed.reasons) ? parsed.reasons : ['Unknown'];
    return parsed;
  } catch (e) {
    console.log(`  ⚠️ Evaluation error: ${e.message} — defaulting to apply`);
    return { score: 3, grade: 'C', recommendation: 'apply', reasons: ['Evaluation failed — defaulting to apply'] };
  }
}
