// Uses native fetch (Node 18+)
import { loadConfig, loadProfile } from '../config.js';
import { callLLM, checkLLMHealth } from './llm.js';

/**
 * Career-Ops style A–F evaluation with 10 weighted dimensions.
 * Uses Groq (cloud) or Ollama (local) — auto-selected by llm.js.
 */
export async function evaluateJob(cvContent, job) {
  const config = loadConfig();
  const profile = loadProfile();

  const systemPrompt = buildSystemPrompt(profile);
  const userPrompt = buildUserPrompt(cvContent, job, profile);

  try {
    const raw = await callLLM(systemPrompt, userPrompt, { json: true, maxTokens: 2000 });
    return parseAIResponse(raw);
  } catch (error) {
    console.error(`  ❌ AI Evaluation Error: ${error.message}`);
    return null;
  }
}


function parseAIResponse(raw) {
  try {
    let jsonStr = raw.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const result = JSON.parse(jsonStr);

    // Validate and normalize dimension_scores
    const dims = result.dimension_scores || {};
    const validGrades = ['A', 'B', 'C', 'D', 'F'];
    for (const key of Object.keys(dims)) {
      if (typeof dims[key] === 'object') {
        dims[key].grade = validGrades.includes(dims[key].grade) ? dims[key].grade : 'C';
      }
    }
    result.dimension_scores = dims;

    // Ensure arrays
    result.matching_skills = Array.isArray(result.matching_skills) ? result.matching_skills : [];
    result.missing_skills = Array.isArray(result.missing_skills) ? result.missing_skills : [];
    result.resume_improvements = Array.isArray(result.resume_improvements) ? result.resume_improvements : [];
    result.star_stories = Array.isArray(result.star_stories) ? result.star_stories : [];

    return result;
  } catch (error) {
    console.error('  ❌ Failed to parse AI response:', error.message);
    console.error('  Raw:', raw?.slice(0, 300));
    return null;
  }
}

function buildSystemPrompt(profile) {
  const weights = profile.scoring_weights || {};
  const dealBreakers = (profile.deal_breakers || []).join(', ');

  return `You are a Career-Ops Job Evaluation Agent. You evaluate job listings against a candidate's CV using a structured A–F scoring system across 10 weighted dimensions.

SCORING SYSTEM (A=5, B=4, C=3, D=2, F=0):

1. TECHNICAL_FIT (${(weights.technical_fit || 0.20) * 100}%): Does the candidate's technical skillset match the core requirements?
2. SENIORITY_ALIGNMENT (${(weights.seniority_alignment || 0.15) * 100}%): Does the required experience level match the candidate's years and depth?
3. DOMAIN_RELEVANCE (${(weights.domain_relevance || 0.15) * 100}%): Does the candidate have industry or domain experience relevant to this role?
4. GROWTH_POTENTIAL (${(weights.growth_potential || 0.10) * 100}%): Will this role meaningfully advance the candidate's career trajectory?
5. COMPANY_SIGNAL (${(weights.company_signal || 0.10) * 100}%): Company reputation, funding stage, engineering culture, growth trajectory.
6. COMPENSATION_FIT (${(weights.compensation_fit || 0.10) * 100}%): Does the likely compensation match expectations? (Infer from role level and location)
7. LOCATION_REMOTE (${(weights.location_remote || 0.05) * 100}%): Does the location/remote policy match the candidate's preference?
8. CULTURAL_INDICATORS (${(weights.cultural_indicators || 0.05) * 100}%): Team size, stated values, work-life signals from the JD.
9. TECH_STACK_FRESHNESS (${(weights.tech_stack_freshness || 0.05) * 100}%): Is the tech stack modern or legacy?
10. VISA_SPONSORSHIP (${(weights.visa_sponsorship || 0.05) * 100}%): Does the role likely support the candidate's work authorization needs?

ARCHETYPE DETECTION: Classify the job into one of: DevOps | Cloud | Data | AI | FullStack | Other

DEAL BREAKERS: ${dealBreakers || 'None specified'}
If a deal breaker is detected, the overall grade MUST be F regardless of other scores.

STAR STORIES: For jobs scoring B or above, suggest 2-3 STAR-format interview talking points based on the candidate's CV that directly address the job requirements.

OUTPUT: Return ONLY valid JSON:
{
  "archetype": "DevOps | Cloud | Data | AI | FullStack | Other",
  "dimension_scores": {
    "technical_fit": { "grade": "A-F", "reason": "brief" },
    "seniority_alignment": { "grade": "A-F", "reason": "brief" },
    "domain_relevance": { "grade": "A-F", "reason": "brief" },
    "growth_potential": { "grade": "A-F", "reason": "brief" },
    "company_signal": { "grade": "A-F", "reason": "brief" },
    "compensation_fit": { "grade": "A-F", "reason": "brief" },
    "location_remote": { "grade": "A-F", "reason": "brief" },
    "cultural_indicators": { "grade": "A-F", "reason": "brief" },
    "tech_stack_freshness": { "grade": "A-F", "reason": "brief" },
    "visa_sponsorship": { "grade": "A-F", "reason": "brief" }
  },
  "matching_skills": ["skill1", "skill2"],
  "missing_skills": ["skill1", "skill2"],
  "resume_improvements": ["suggestion1", "suggestion2"],
  "star_stories": [
    { "situation": "...", "task": "...", "action": "...", "result": "..." }
  ],
  "reason": "One-sentence summary of the evaluation"
}

RULES:
- Output ONLY JSON — no markdown, no explanations
- Do NOT hallucinate skills the candidate doesn't have
- Be realistic and honest in grading
- Grade C means "average/neutral", not "bad"
- Use the full grade range (don't cluster everything at B/C)`;
}

function buildUserPrompt(cvContent, job, profile) {
  const prefs = profile.preferences || {};
  const comp = profile.compensation || {};

  // Truncate CV to key sections only for speed
  const shortCV = cvContent.slice(0, 1500);

  return `CV SUMMARY:
${shortCV}

TARGET: ${(profile.target_roles || []).join(', ')} | ${(profile.target_locations || []).join(', ')} | ${prefs.remote_preference || 'any'} | ${comp.min_annual_eur || '?'}–${comp.target_annual_eur || '?'} EUR

JOB: ${job.title} at ${job.company} (${job.platform})
Location: ${job.location || 'N/A'} | Remote: ${job.remote ? 'Yes' : 'Unknown'}
Description:
${(job.description || 'No description').slice(0, 1500)}

Return ONLY JSON.`;
}

// Re-export health check from llm.js
export { checkLLMHealth as checkOllamaHealth };
