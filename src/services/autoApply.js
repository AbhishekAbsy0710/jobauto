// Uses native fetch (Node 18+)
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, loadProfile } from '../config.js';
import { insertApplication, updateJobStatus } from '../database.js';
// pdfGenerator and resumeTailor loaded lazily to avoid Playwright dependency at import time

/**
 * Auto-Apply Service.
 * Submits applications via Greenhouse, Lever, and Ashby public APIs.
 * For non-API platforms, generates tailored PDF and notifies for manual apply.
 */

const API_PLATFORMS = ['greenhouse', 'lever', 'ashby'];

export async function processApplication(job, evaluation) {
  const config = loadConfig();
  const profile = loadProfile();

  if (config.autoApplyMode === 'off') {
    console.log(`  ⏸️ Auto-apply disabled — skipping ${job.title}`);
    return { status: 'skipped', reason: 'auto-apply off' };
  }

  console.log(`\n  🚀 Processing application: ${job.title} at ${job.company}`);

  try {
    // Step 1: Tailor resume (via Ollama)
    let tailoredBullets = [];
    try {
      const { tailorResume } = await import('./resumeTailor.js');
      console.log('  📝 Step 1: Tailoring resume...');
      tailoredBullets = await tailorResume(job, evaluation);
    } catch (e) {
      console.log(`  ⚠️ Resume tailoring skipped: ${e.message}`);
    }

    // Step 2: Use base resume PDF (Playwright PDF gen disabled — too heavy)
    let pdfResult = null;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const basePdf = join(__dirname, '..', '..', 'resume', 'resume.pdf');
    if (existsSync(basePdf)) {
      pdfResult = { path: basePdf, filename: 'Abhishek_Raj_Pagadala_Resume.pdf' };
      console.log('  📄 Step 2: Using base resume PDF');
    } else {
      console.log('  ⚠️ No resume PDF found at resume/resume.pdf');
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

    // Step 4: Submit or notify
    const platform = (job.platform || '').toLowerCase();
    const canAutoApply = API_PLATFORMS.includes(platform);

    if (canAutoApply && pdfResult) {
      console.log(`  🤖 Step 4: Auto-submitting via ${platform} API...`);
      const result = await submitApplication(job, evaluation, pdfResult, coverLetter, config, profile);

      if (result.success) {
        insertApplication(evaluation.id || 0, 'auto', pdfResult.path);
        updateJobStatus(job.id, 'applied');
        console.log(`  ✅ Application submitted to ${job.company}!`);
      }

      return {
        status: result.success ? 'submitted' : 'failed',
        platform,
        pdfPath: pdfResult.path,
        coverLetter,
        error: result.error
      };
    } else {
      console.log(`  👋 Step 4: ${platform} — materials ready for manual apply`);
      return {
        status: 'manual',
        platform,
        pdfPath: pdfResult?.path,
        pdfFilename: pdfResult?.filename,
        coverLetter,
        reason: `${platform} requires manual application`
      };
    }
  } catch (error) {
    console.error(`  ❌ Application processing failed: ${error.message}`);
    return { status: 'error', error: error.message };
  }
}

// ============================================
// PLATFORM-SPECIFIC SUBMISSION
// ============================================

async function submitApplication(job, evaluation, pdfResult, coverLetter, config, profile) {
  const platform = (job.platform || '').toLowerCase();

  try {
    switch (platform) {
      case 'greenhouse':
        return await submitGreenhouse(job, pdfResult, coverLetter, config, profile);
      case 'lever':
        return await submitLever(job, pdfResult, coverLetter, config, profile);
      case 'ashby':
        return await submitAshby(job, pdfResult, coverLetter, config, profile);
      default:
        return { success: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================
// GREENHOUSE APPLY API
// ============================================
async function submitGreenhouse(job, pdfResult, coverLetter, config, profile) {
  // Extract board_id and job_id from external_id: "greenhouse_{board}_{id}"
  const parts = (job.external_id || '').split('_');
  if (parts.length < 3) return { success: false, error: 'Cannot parse Greenhouse job ID' };

  const boardId = parts[1];
  const jobId = parts.slice(2).join('_');
  // Greenhouse candidate application API (no auth required)
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardId}/jobs/${jobId}/candidates`;

  // Read PDF file
  const pdfBuffer = readFileSync(pdfResult.path);
  const boundary = '----FormBoundary' + Date.now().toString(36);
  const name = profile.identity?.name || 'Abhishek Raj Pagadala';
  const [firstName, ...lastParts] = name.split(' ');
  const lastName = lastParts.join(' ') || firstName;

  const body = buildMultipartBody(boundary, {
    first_name: firstName,
    last_name: lastName,
    email: config.applicantEmail,
    phone: config.applicantPhone,
    cover_letter: coverLetter,
  }, {
    resume: { filename: pdfResult.filename, buffer: pdfBuffer, contentType: 'application/pdf' }
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body,
      signal: AbortSignal.timeout(30000)
    });

    if (response.ok || response.status === 201) {
      return { success: true };
    } else {
      const text = await response.text();
      return { success: false, error: `Greenhouse ${response.status}: ${text.slice(0, 200)}` };
    }
  } catch (error) {
    return { success: false, error: `Greenhouse: ${error.message}` };
  }
}

// ============================================
// LEVER APPLY API
// ============================================
async function submitLever(job, pdfResult, coverLetter, config, profile) {
  // Extract company and posting from external_id: "lever_{company}_{id}"
  const parts = (job.external_id || '').split('_');
  if (parts.length < 3) return { success: false, error: 'Cannot parse Lever job ID' };

  const companyId = parts[1];
  const postingId = parts.slice(2).join('_');
  const url = `https://api.lever.co/v0/postings/${companyId}/${postingId}/apply`;

  const pdfBuffer = readFileSync(pdfResult.path);
  const boundary = '----FormBoundary' + Date.now().toString(36);
  const name = profile.identity?.name || 'Abhishek Raj Pagadala';

  const body = buildMultipartBody(boundary, {
    name: name,
    email: config.applicantEmail,
    phone: config.applicantPhone,
    comments: coverLetter,
    org: 'N/A',
    urls: JSON.stringify([
      'https://linkedin.com/in/abhishek-raj-pagadala',
      'https://github.com/abhishek-raj-pagadala'
    ])
  }, {
    resume: { filename: pdfResult.filename, buffer: pdfBuffer, contentType: 'application/pdf' }
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body,
      signal: AbortSignal.timeout(30000)
    });

    if (response.ok) {
      return { success: true };
    } else {
      const text = await response.text();
      return { success: false, error: `Lever ${response.status}: ${text.slice(0, 200)}` };
    }
  } catch (error) {
    return { success: false, error: `Lever: ${error.message}` };
  }
}

// ============================================
// ASHBY APPLY API
// ============================================
async function submitAshby(job, pdfResult, coverLetter, config, profile) {
  const parts = (job.external_id || '').split('_');
  if (parts.length < 3) return { success: false, error: 'Cannot parse Ashby job ID' };

  const jobId = parts.slice(2).join('_');
  const url = 'https://api.ashbyhq.com/posting-api/application';

  const pdfBuffer = readFileSync(pdfResult.path);
  const name = profile.identity?.name || 'Abhishek Raj Pagadala';
  const [firstName, ...lastParts] = name.split(' ');
  const lastName = lastParts.join(' ') || firstName;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobPostingId: jobId,
        applicationForm: {
          firstName,
          lastName,
          email: config.applicantEmail,
          phone: config.applicantPhone,
          resumeFileContent: pdfBuffer.toString('base64'),
          resumeFileName: pdfResult.filename,
          coverLetter: coverLetter
        }
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (response.ok) {
      return { success: true };
    } else {
      const text = await response.text();
      return { success: false, error: `Ashby ${response.status}: ${text.slice(0, 200)}` };
    }
  } catch (error) {
    return { success: false, error: `Ashby: ${error.message}` };
  }
}

// ============================================
// MULTIPART FORM BUILDER
// ============================================
function buildMultipartBody(boundary, fields, files) {
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${key}"\r\n\r\n`,
      `${value}\r\n`
    );
  }

  for (const [key, file] of Object.entries(files)) {
    parts.push(
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${key}"; filename="${file.filename}"\r\n`,
      `Content-Type: ${file.contentType}\r\n\r\n`
    );
    parts.push(file.buffer);
    parts.push('\r\n');
  }

  parts.push(`--${boundary}--\r\n`);

  // Concat buffers and strings
  const buffers = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
  return Buffer.concat(buffers);
}
