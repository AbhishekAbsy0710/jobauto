import nodemailer from 'nodemailer';
import { loadConfig } from '../config.js';
import { findHiringManagerEmail } from './email-finder.js';

// Shared Groq call (use 8b for speed, fallback to 70b)
async function callGroq(systemPrompt, userPrompt, model = 'llama-3.1-8b-instant') {
  if (!process.env.GROQ_API_KEY) return '{}';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    }),
  });
  
  if (!res.ok) {
    if (res.status === 413 && model === 'llama-3.1-8b-instant') {
      return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
    }
    if (res.status === 429 && model === 'llama-3.1-8b-instant') {
       return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
    }
    return '{}';
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '{}';
}

/**
 * Generate a personalized cold email using AI
 */
async function generateColdEmail(job, resumeContent) {
  const prompt = `
You are an expert career coach writing a cold email to a hiring manager.
Your goal is to write a short, highly personalized, and professional email applying for the "${job.title}" role at ${job.company}.

Input:
Candidate Resume: ${resumeContent.substring(0, 3000)}
Job Description: ${job.description ? job.description.substring(0, 3000) : job.title}

Rules:
1. Subject line should be catchy and professional (e.g., "Application: [Role] - [Candidate Name]")
2. Body should be exactly 3 short paragraphs.
3. Paragraph 1 (Hook): Express interest in the specific role at the specific company.
4. Paragraph 2 (Value): Highlight 1-2 very specific achievements from the resume that directly match the core requirements of the job.
5. Paragraph 3 (CTA): Mention the resume is attached and ask for a brief chat.
6. Tone: Confident, concise, professional, not desperate.

Output MUST be a JSON object:
{
  "subject": "The email subject",
  "body": "The email body text (use \\n for line breaks)"
}
  `;

  const aiResult = await callGroq(
    "You are an expert cold email copywriter. Always return valid JSON.",
    prompt
  );

  try {
    return JSON.parse(aiResult);
  } catch (e) {
    console.error("Failed to parse cold email AI response:", aiResult);
    return null;
  }
}

/**
 * Send the cold email via Gmail SMTP
 */
export async function sendColdEmail(job, emailAddress, resumeContent, resumePdfPath) {
  const config = loadConfig();
  
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("  ⚠️ Missing GMAIL_USER or GMAIL_APP_PASSWORD in .env. Skipping cold email.");
    return false;
  }
  
  if (!emailAddress) {
    // Use DNS+SMTP email finder instead of a naive guess
    console.log(`  🔍 Looking up hiring manager email for ${job.company}...`);
    emailAddress = await findHiringManagerEmail(job.company);
  }

  console.log(`  📧 Generating cold email for ${job.company}...`);
  const emailContent = await generateColdEmail(job, resumeContent);
  
  if (!emailContent || !emailContent.subject || !emailContent.body) {
    console.log("  ⚠️ Failed to generate cold email content.");
    return false;
  }

  // Setup Nodemailer
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: emailAddress,
    subject: emailContent.subject,
    text: emailContent.body,
    attachments: resumePdfPath ? [
      {
        filename: 'Abhishek_Resume.pdf',
        path: resumePdfPath
      }
    ] : []
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`  ✅ Cold email sent to ${emailAddress}! Message ID: ${info.messageId}`);
    return emailAddress;
  } catch (error) {
    console.log(`  ❌ Failed to send cold email: ${error.message}`);
    return false;
  }
}
