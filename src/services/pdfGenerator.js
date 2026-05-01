import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { loadCV, loadProfile } from '../config.js';
import { evaluateJob } from './evaluator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', '..', 'output');
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'cv-template.html');

/**
 * Generate a tailored PDF resume for a specific job.
 * Uses Playwright to render HTML → PDF.
 */
export async function generateTailoredPDF(job, tailoredBullets = null) {
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const cvContent = loadCV();
  const profile = loadProfile();

  if (!cvContent) {
    throw new Error('No CV found — add resume/cv.md');
  }

  // If no pre-tailored bullets provided, generate them via AI
  let customizedCV = cvContent;
  if (tailoredBullets && Array.isArray(tailoredBullets)) {
    customizedCV = applyTailoredBullets(cvContent, tailoredBullets);
  }

  // Render markdown to HTML
  const cvHtml = marked.parse(customizedCV);

  // Load template and inject content
  let template;
  if (existsSync(TEMPLATE_PATH)) {
    template = readFileSync(TEMPLATE_PATH, 'utf-8');
  } else {
    template = getDefaultTemplate();
  }

  const html = template
    .replace('{{CV_CONTENT}}', cvHtml)
    .replace('{{NAME}}', profile.identity?.name || 'Candidate')
    .replace('{{TARGET_ROLE}}', job.title || '')
    .replace('{{COMPANY}}', job.company || '')
    .replace('{{DATE}}', new Date().toISOString().split('T')[0]);

  // Generate PDF using Playwright
  const sanitizedCompany = (job.company || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_');
  const sanitizedTitle = (job.title || 'Role').replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `CV_${sanitizedCompany}_${sanitizedTitle}.pdf`;
  const pdfPath = join(OUTPUT_DIR, filename);

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
      printBackground: true
    });
    await browser.close();
    console.log(`  📄 PDF generated: ${filename}`);
    return { path: pdfPath, filename };
  } catch (error) {
    // Fallback: save HTML if Playwright not installed
    const htmlPath = pdfPath.replace('.pdf', '.html');
    writeFileSync(htmlPath, html);
    console.log(`  ⚠️ Playwright not available — saved HTML: ${htmlPath.split('/').pop()}`);
    console.log(`    Install with: npx playwright install chromium`);
    return { path: htmlPath, filename: filename.replace('.pdf', '.html') };
  }
}

function applyTailoredBullets(cvContent, bullets) {
  // Simple strategy: prepend a "Tailored Highlights" section
  const section = '\n## Tailored Highlights\n\n' +
    bullets.map(b => `- ${b}`).join('\n') + '\n\n---\n';
  return cvContent.replace(/^(# .+\n)/, `$1${section}`);
}

function getDefaultTemplate() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #1a1a2e;
      max-width: 100%;
    }
    h1 { font-size: 22pt; color: #16213e; margin-bottom: 4px; }
    h2 { font-size: 13pt; color: #0f3460; border-bottom: 1.5px solid #e2e8f0; padding-bottom: 4px; margin: 16px 0 8px; }
    h3 { font-size: 11pt; color: #16213e; margin: 10px 0 4px; }
    p { margin-bottom: 6px; }
    ul { margin: 4px 0 8px 20px; }
    li { margin-bottom: 3px; }
    em { font-style: italic; color: #555; }
    strong { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10pt; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e2e8f0; }
    th { color: #0f3460; font-weight: 600; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 12px 0; }
    a { color: #0f3460; text-decoration: none; }
    code { font-family: monospace; font-size: 10pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
    .header-meta { font-size: 9pt; color: #666; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="header-meta">Tailored for: {{TARGET_ROLE}} at {{COMPANY}} · Generated {{DATE}}</div>
  {{CV_CONTENT}}
</body>
</html>`;
}
