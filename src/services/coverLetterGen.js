// Uses native fetch (Node 18+)
import { loadConfig, loadProfile, loadCV } from '../config.js';

/**
 * Cover Letter Generator.
 * 3-paragraph cover letter personalized per job using Ollama.
 */
export async function generateCoverLetter(job, evaluation) {
  const config = loadConfig();
  const profile = loadProfile();
  const cvContent = loadCV();

  const matchingSkills = (evaluation?.matching_skills || []).join(', ');
  const starStories = evaluation?.star_stories || [];
  const starText = starStories.length > 0
    ? starStories.map(s => `${s.situation} → ${s.action} → ${s.result}`).join('\n')
    : '';

  const prompt = `Write a concise, professional cover letter (3 paragraphs, max 250 words) for this job application.

CANDIDATE: ${profile.identity?.name || 'Abhishek Raj Pagadala'}
CANDIDATE SUMMARY: ${(profile.narrative || '').slice(0, 500)}
KEY MATCHING SKILLS: ${matchingSkills}
${starText ? `RELEVANT ACHIEVEMENTS:\n${starText}` : ''}

JOB:
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location || 'Europe'}
- Description: ${(job.description || '').slice(0, 1500)}

STRUCTURE:
- Paragraph 1: Express genuine interest in ${job.company} and this specific role. Mention something specific about the company.
- Paragraph 2: Highlight 2-3 directly relevant achievements from the candidate's experience. Use specific metrics where possible.
- Paragraph 3: What you'd bring to the team + enthusiasm + call to action.

RULES:
- Professional but not stiff
- No generic phrases like "I am writing to express my interest"
- Be specific to this company and role
- Keep it under 250 words
- Do NOT use placeholder text

Return ONLY the cover letter text, no JSON, no markdown headers.`;

  try {
    const url = `${config.ollamaBaseUrl}/api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.4, num_predict: 1500 }
      }),
      signal: AbortSignal.timeout(300000)
    });

    if (!response.ok) throw new Error(`Ollama ${response.status}`);
    const data = await response.json();
    const letter = (data.message?.content || '').trim();

    console.log(`  ✉️ Cover letter generated (${letter.split(' ').length} words)`);
    return letter;
  } catch (error) {
    console.error(`  ⚠️ Cover letter generation failed: ${error.message}`);
    return generateFallbackLetter(job, profile);
  }
}

function generateFallbackLetter(job, profile) {
  const name = profile.identity?.name || 'Abhishek Raj Pagadala';
  return `Dear Hiring Team at ${job.company},

I am excited about the ${job.title} opportunity at ${job.company}. With 5+ years of experience in full-stack development, DevOps, and cloud infrastructure, I bring a strong combination of hands-on engineering expertise and a passion for building scalable, reliable systems.

In my current role at Ayonic GmbH, I architect CI/CD pipelines, manage Azure cloud infrastructure, and build cross-platform mobile applications. I have also pioneered AI-augmented development practices that have accelerated our delivery velocity by 3x. My experience with ${(profile.core_skills?.infrastructure || []).slice(0, 3).join(', ')} aligns well with this role's requirements.

I would welcome the opportunity to discuss how my experience can contribute to ${job.company}'s mission. I am available for an interview at your convenience.

Best regards,
${name}`;
}
