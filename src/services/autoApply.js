// Uses native fetch (Node 18+)
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, loadProfile } from '../config.js';
import { insertApplication, updateJobStatus } from '../database.js';
import { generateTailoredResume } from './resumeBuilder.js';
import { submitToATS, DRY_RUN } from './atsSubmitter.js';

/**
 * Auto-Apply Service.
 * Submits applications via ATS public APIs (Greenhouse, Lever, Ashby).
 * Falls back to n8n webhook for unsupported platforms.
 */

const ATS_PLATFORMS = ['greenhouse', 'lever', 'ashby'];

export async function processApplication(job, evaluation) {
  const config = loadConfig();
  const profile = loadProfile();

  if (config.autoApplyMode === 'off') {
    console.log(`  ⏸️ Auto-apply disabled — skipping ${job.title}`);
    return { status: 'skipped', reason: 'auto-apply off' };
  }

  const platform = (job.platform || '').toLowerCase();
  console.log(`\n  🚀 Processing application: ${job.title} at ${job.company} [${platform}]`);

  try {
    // Step 1 & 2: V2 Non-Destructive Tailoring & PDF Generation
    let pdfResult = null;
    try {
      console.log('  📝 Step 1 & 2: Generating V2 tailored HTML...');
      const fallbackPdf = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resume', 'resume.pdf');
      const genResult = await generateTailoredResume(job, null, null, fallbackPdf);
      
      pdfResult = { 
        path: genResult.pdfPath, 
        filename: `Abhishek_Raj_Pagadala_Resume_${job.id}.pdf` 
      };
      console.log(`  📄 Tailored resume ready fallback used for PDF`);
    } catch (e) {
      console.log(`  ⚠️ Resume generation failed: ${e.message}`);
      // Fallback
      const fallbackPdf = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resume', 'resume.pdf');
      if (existsSync(fallbackPdf)) {
        pdfResult = { path: fallbackPdf, filename: 'Abhishek_Raj_Pagadala_Resume.pdf' };
      }
    }

    // Step 3: Generate cover letter
    let coverLetter = '';
    try {
      const { generateCoverLetter } = await import('./coverLetterGen.js');
      console.log('  ✉️ Step 3: Generating cover letter...');
      coverLetter = await generateCoverLetter(job, evaluation);
    } catch (e) {
      console.log(`  ⚠️ Cover letter skipped: ${e.message}`);
    }

    if (!pdfResult) {
      console.log(`  ❌ No resume available — cannot apply`);
      return { status: 'failed', error: 'No resume PDF available' };
    }

    // Step 4: Submit — ATS API first, then n8n fallback
    const applicant = {
      name: profile.identity?.name || 'Abhishek Raj Pagadala',
      email: config.applicantEmail,
      phone: config.applicantPhone,
      linkedin: profile.identity?.linkedin || '',
    };

    let result;
    let method = 'n8n';

    if (ATS_PLATFORMS.includes(platform)) {
      // Try direct ATS API submission
      console.log(`  🎯 Step 4: Direct ATS submission (${platform})...`);
      result = await submitToATS(platform, job.apply_link, applicant, pdfResult.path, coverLetter);

      if (result.success) {
        method = result.method || `${platform}_api`;
        const dryNote = result.dryRun ? ' [DRY RUN]' : '';
        console.log(`  ✅ ATS SUBMITTED → ${job.company} via ${method}${dryNote}`);
        if (result.confirmationId) {
          console.log(`  🆔 Confirmation: ${result.confirmationId}`);
        }
      } else {
        // ATS failed — fall back to n8n
        console.log(`  ⚠️ ATS API failed (${result.error}), falling back to n8n webhook...`);
        if (config.n8nWebhookUrl) {
          result = await submitToN8N(job, evaluation, pdfResult, coverLetter, config, profile);
          method = 'n8n_fallback';
        }
      }
    } else if (config.n8nWebhookUrl) {
      // Non-ATS platform — go straight to n8n
      console.log(`  🤖 Step 4: Dispatching to n8n webhook (${platform})...`);
      result = await submitToN8N(job, evaluation, pdfResult, coverLetter, config, profile);
      method = 'n8n';
    } else {
      console.log(`  👋 Step 4: ${platform} — materials ready for manual apply`);
      return {
        status: 'manual',
        platform,
        pdfPath: pdfResult.path,
        coverLetter,
        reason: 'No ATS API and no n8n webhook configured',
      };
    }

    if (result && result.success) {
      // Store method info: "greenhouse_api" or "n8n" or "n8n_fallback"
      const methodStr = result.dryRun ? `${method}|DRY_RUN` : method;
      insertApplication(evaluation.id || 0, methodStr, pdfResult.path);
      updateJobStatus(job.id, 'applied');
      console.log(`  ✅ Application recorded: ${job.company} → ${methodStr}`);
    } else if (result) {
      console.log(`  ❌ Submission failed: ${result.error}`);
    }

    return {
      status: result?.success ? 'submitted' : 'failed',
      platform,
      method,
      pdfPath: pdfResult.path,
      coverLetter,
      confirmationId: result?.confirmationId,
      dryRun: result?.dryRun || false,
      error: result?.error,
    };

  } catch (error) {
    console.error(`  ❌ Application processing failed: ${error.message}`);
    return { status: 'error', error: error.message };
  }
}

// ============================================
// N8N WEBHOOK DISPATCHER (Fallback)
// ============================================
async function submitToN8N(job, evaluation, pdfResult, coverLetter, config, profile) {
  const url = config.n8nWebhookUrl;
  
  // Read PDF file as Base64 to send in JSON payload
  const pdfBuffer = readFileSync(pdfResult.path);
  const pdfBase64 = pdfBuffer.toString('base64');
  
  const payload = {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      platform: job.platform,
      apply_link: job.apply_link,
      remote: job.remote
    },
    evaluation: {
      id: evaluation.id,
      grade: evaluation.letter_grade,
      archetype: evaluation.archetype,
      reason: evaluation.reason
    },
    applicant: {
      name: profile.identity?.name || 'Abhishek Raj Pagadala',
      email: config.applicantEmail,
      phone: config.applicantPhone
    },
    assets: {
      cover_letter: coverLetter,
      resume_filename: pdfResult.filename,
      resume_base64: pdfBase64
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    if (response.ok || response.status === 201) {
      return { success: true, method: 'n8n' };
    } else {
      const text = await response.text();
      return { success: false, error: `n8n Webhook ${response.status}: ${text.slice(0, 200)}`, method: 'n8n' };
    }
  } catch (error) {
    return { success: false, error: `n8n Webhook failed: ${error.message}`, method: 'n8n' };
  }
}

