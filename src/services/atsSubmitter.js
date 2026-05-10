/**
 * ATS Direct Submitter
 * Submits applications directly to Greenhouse, Lever, and Ashby public APIs.
 * 
 * DRY_RUN=true (default) → logs what would be sent without actually submitting
 * DRY_RUN=false → sends real applications
 */
import { readFileSync } from 'fs';

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

// ============================================
// URL PARSERS
// ============================================

/**
 * Greenhouse URLs:
 *   https://job-boards.greenhouse.io/{board_token}/jobs/{job_id}
 *   https://careers.example.com/detail/{id}/?gh_jid={gh_job_id}
 */
function parseGreenhouseUrl(url) {
  // Pattern 1: job-boards.greenhouse.io/{board}/jobs/{id}
  let match = url.match(/job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (match) return { boardToken: match[1], jobId: match[2] };

  // Pattern 2: ?gh_jid={id} with board token in path
  match = url.match(/gh_jid=(\d+)/);
  if (match) {
    // Try to extract board from URL path
    const pathMatch = url.match(/greenhouse\.io\/([^/]+)/);
    const boardToken = pathMatch ? pathMatch[1] : null;
    return { boardToken, jobId: match[1] };
  }

  return null;
}

/**
 * Lever URLs:
 *   https://jobs.lever.co/{company}/{posting_id}
 */
function parseLeverUrl(url) {
  const match = url.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)/);
  if (match) return { company: match[1], postingId: match[2] };
  return null;
}

/**
 * Ashby URLs:
 *   https://jobs.ashbyhq.com/{organization}/{job_id}
 */
function parseAshbyUrl(url) {
  const match = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]+)/);
  if (match) return { organization: match[1], jobPostingId: match[2] };
  return null;
}

// ============================================
// GREENHOUSE SUBMISSION
// ============================================

/**
 * Greenhouse Public Application API
 * POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}/applications
 * Content-Type: multipart/form-data
 */
export async function submitToGreenhouse(applyLink, applicant, resumePath, coverLetter) {
  const parsed = parseGreenhouseUrl(applyLink);
  if (!parsed || !parsed.boardToken) {
    return { success: false, error: 'Could not parse Greenhouse board token from URL', method: 'greenhouse_api' };
  }

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${parsed.boardToken}/jobs/${parsed.jobId}/applications`;

  if (DRY_RUN) {
    console.log(`    🔍 [DRY RUN] Greenhouse API → ${apiUrl}`);
    console.log(`    🔍 [DRY RUN] Applicant: ${applicant.name} <${applicant.email}>`);
    console.log(`    🔍 [DRY RUN] Resume: ${resumePath}`);
    console.log(`    🔍 [DRY RUN] Cover letter: ${coverLetter ? coverLetter.length + ' chars' : 'none'}`);
    return { success: true, method: 'greenhouse_api', dryRun: true, apiUrl };
  }

  try {
    const resumeBuffer = readFileSync(resumePath);
    const blob = new Blob([resumeBuffer], { type: 'application/pdf' });

    const form = new FormData();
    form.append('first_name', applicant.name.split(' ')[0]);
    form.append('last_name', applicant.name.split(' ').slice(1).join(' '));
    form.append('email', applicant.email);
    if (applicant.phone) form.append('phone', applicant.phone);
    form.append('resume', blob, 'resume.pdf');
    if (coverLetter) form.append('cover_letter', coverLetter);

    const response = await fetch(apiUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok || response.status === 201) {
      const data = await response.json().catch(() => ({}));
      return { 
        success: true, 
        method: 'greenhouse_api', 
        confirmationId: data.id || data.application_id || null,
        status: response.status
      };
    } else {
      const text = await response.text();
      return { success: false, error: `Greenhouse ${response.status}: ${text.slice(0, 300)}`, method: 'greenhouse_api' };
    }
  } catch (e) {
    return { success: false, error: `Greenhouse API error: ${e.message}`, method: 'greenhouse_api' };
  }
}

// ============================================
// LEVER SUBMISSION
// ============================================

/**
 * Lever Public Application API
 * POST https://api.lever.co/v0/postings/{company}/{posting_id}?key=...
 * Content-Type: multipart/form-data
 */
export async function submitToLever(applyLink, applicant, resumePath, coverLetter) {
  const parsed = parseLeverUrl(applyLink);
  if (!parsed) {
    return { success: false, error: 'Could not parse Lever URL', method: 'lever_api' };
  }

  const apiUrl = `https://api.lever.co/v0/postings/${parsed.company}/${parsed.postingId}`;

  if (DRY_RUN) {
    console.log(`    🔍 [DRY RUN] Lever API → ${apiUrl}`);
    console.log(`    🔍 [DRY RUN] Applicant: ${applicant.name} <${applicant.email}>`);
    console.log(`    🔍 [DRY RUN] Resume: ${resumePath}`);
    return { success: true, method: 'lever_api', dryRun: true, apiUrl };
  }

  try {
    const resumeBuffer = readFileSync(resumePath);
    const blob = new Blob([resumeBuffer], { type: 'application/pdf' });

    const form = new FormData();
    form.append('name', applicant.name);
    form.append('email', applicant.email);
    if (applicant.phone) form.append('phone', applicant.phone);
    form.append('resume', blob, 'resume.pdf');
    if (coverLetter) form.append('comments', coverLetter);
    // Lever sometimes needs these
    form.append('org', 'API');
    form.append('urls[LinkedIn]', applicant.linkedin || '');

    const response = await fetch(apiUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok || response.status === 201) {
      const data = await response.json().catch(() => ({}));
      return { 
        success: true, 
        method: 'lever_api',
        confirmationId: data.applicationId || data.id || null,
        status: response.status
      };
    } else {
      const text = await response.text();
      return { success: false, error: `Lever ${response.status}: ${text.slice(0, 300)}`, method: 'lever_api' };
    }
  } catch (e) {
    return { success: false, error: `Lever API error: ${e.message}`, method: 'lever_api' };
  }
}

// ============================================
// ASHBY SUBMISSION
// ============================================

/**
 * Ashby Public Application API
 * POST https://api.ashbyhq.com/applicationForm.submit
 * Content-Type: application/json (with base64 resume)
 */
export async function submitToAshby(applyLink, applicant, resumePath, coverLetter) {
  const parsed = parseAshbyUrl(applyLink);
  if (!parsed) {
    return { success: false, error: 'Could not parse Ashby URL', method: 'ashby_api' };
  }

  const apiUrl = 'https://api.ashbyhq.com/applicationForm.submit';

  if (DRY_RUN) {
    console.log(`    🔍 [DRY RUN] Ashby API → ${apiUrl}`);
    console.log(`    🔍 [DRY RUN] Job Posting: ${parsed.jobPostingId} (${parsed.organization})`);
    console.log(`    🔍 [DRY RUN] Applicant: ${applicant.name} <${applicant.email}>`);
    return { success: true, method: 'ashby_api', dryRun: true, apiUrl };
  }

  try {
    const resumeBuffer = readFileSync(resumePath);
    const resumeBase64 = resumeBuffer.toString('base64');

    // Ashby first needs the form structure — fetch it
    const formRes = await fetch('https://api.ashbyhq.com/applicationForm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobPostingId: parsed.jobPostingId }),
      signal: AbortSignal.timeout(15000),
    });

    if (!formRes.ok) {
      return { success: false, error: `Ashby form fetch ${formRes.status}`, method: 'ashby_api' };
    }

    const formData = await formRes.json();
    const formDef = formData.form || formData;
    const formId = formDef.id;

    if (!formId) {
      return { success: false, error: 'No Ashby form ID found', method: 'ashby_api' };
    }

    // Build field values from form definition
    const fieldValues = [];
    const sections = formDef.sections || [];
    for (const section of sections) {
      for (const field of (section.fields || [])) {
        const path = field.path || '';
        const type = field.type || '';

        if (path === '_systemfield_name') {
          fieldValues.push({ path, value: applicant.name });
        } else if (path === '_systemfield_email') {
          fieldValues.push({ path, value: applicant.email });
        } else if (path === '_systemfield_phone') {
          fieldValues.push({ path, value: applicant.phone || '' });
        } else if (type === 'File' && path.includes('resume')) {
          fieldValues.push({
            path,
            value: { fileName: 'resume.pdf', mimeType: 'application/pdf', content: resumeBase64 }
          });
        } else if (path.includes('cover') && coverLetter) {
          fieldValues.push({ path, value: coverLetter });
        }
        // Skip optional fields we don't have data for
      }
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        applicationFormId: formId,
        jobPostingId: parsed.jobPostingId,
        fieldValues,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok || response.status === 201) {
      const data = await response.json().catch(() => ({}));
      return { 
        success: true, 
        method: 'ashby_api',
        confirmationId: data.applicationId || data.id || null,
        status: response.status
      };
    } else {
      const text = await response.text();
      return { success: false, error: `Ashby ${response.status}: ${text.slice(0, 300)}`, method: 'ashby_api' };
    }
  } catch (e) {
    return { success: false, error: `Ashby API error: ${e.message}`, method: 'ashby_api' };
  }
}

// ============================================
// PLATFORM ROUTER
// ============================================

/**
 * Routes to the correct ATS API based on platform.
 * Returns { success, method, confirmationId, dryRun?, error? }
 */
export async function submitToATS(platform, applyLink, applicant, resumePath, coverLetter) {
  const p = (platform || '').toLowerCase();

  console.log(`    📡 ATS Submit: ${p} | DRY_RUN=${DRY_RUN}`);

  switch (p) {
    case 'greenhouse':
      return await submitToGreenhouse(applyLink, applicant, resumePath, coverLetter);
    case 'lever':
      return await submitToLever(applyLink, applicant, resumePath, coverLetter);
    case 'ashby':
      return await submitToAshby(applyLink, applicant, resumePath, coverLetter);
    default:
      return { success: false, error: `No ATS API for platform: ${p}`, method: 'unsupported' };
  }
}

export { DRY_RUN };
