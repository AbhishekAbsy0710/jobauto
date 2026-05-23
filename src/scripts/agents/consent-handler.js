/**
 * agents/consent-handler.js — Cookie & GDPR Consent Agent
 * 
 * Handles ALL cookie consent flows across ATS platforms:
 * - Generic cookie banners (Accept All, Got it, etc.)
 * - OneTrust (SmartRecruiters) — CSS-hide approach (NOT DOM removal)
 * - SmartRecruiters "I'm interested" / "Apply" button detection
 * - Per-step OneTrust overlay safety checks
 * 
 * CRITICAL: SR's React SPA depends on OneTrust DOM elements existing.
 *   Removing them breaks the SPA hydration and prevents the form from rendering.
 *   We use CSS `display: none !important` instead to hide overlays without breaking React.
 * 
 * Exports:
 *   - dismissCookieBanners(page) — generic cookie banner dismiss
 *   - handleSRCookieConsent(page) — SR-specific cookie banner + OneTrust hide
 *   - findAndClickSRApplyButton(page) — find "I'm interested"/"Apply" and navigate
 *   - waitForSRFormRender(page) — wait for SR oneclick-ui form to mount
 *   - ensureNoOverlay(page, stepCount) — per-step overlay safety
 */

// ── Generic Cookie Banner Dismiss ──────────────────────────────────────────────
export async function dismissCookieBanners(page) {
  const cookieSelectors = [
    'button:has-text("Accept")', 'button:has-text("Accept All")', 'button:has-text("Accept all")',
    'button:has-text("Agree")', 'button:has-text("Got it")', 'button:has-text("OK")',
    'button:has-text("I agree")', 'button:has-text("Allow all")',
    'button[id*="cookie"] >> text=Accept', 'button[id*="consent"] >> text=Accept',
    '#onetrust-accept-btn-handler', '.cookie-consent-accept', '#cookie-accept',
    '[data-testid="cookie-accept"]', '.cc-accept', '.cc-btn.cc-allow',
  ];
  for (const sel of cookieSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click({ timeout: 2000 });
        console.log('  🍪 Dismissed cookie banner');
        await page.waitForTimeout(500);
        break;
      }
    } catch {}
  }
}

// ── SmartRecruiters Cookie Consent ─────────────────────────────────────────────
/**
 * Handle SR-specific cookie consent on job posting page AND oneclick-ui page.
 * Uses CSS-hide (NOT DOM removal) to preserve React SPA integrity.
 * 
 * @param {import('playwright').Page} page
 */
export async function handleSRCookieConsent(page) {
  if (!page.url().includes('smartrecruiters.com')) return;

  console.log(`  🍪 Handling SmartRecruiters cookie consent...`);

  // Try clicking Reject All / Accept All / Save Preferences in cookie modal
  const cookieBtns = [
    'button#onetrust-reject-all-handler',
    'button#onetrust-accept-btn-handler',
    'button.save-preference-btn-handler',
    'button:has-text("Reject All")',
    'button:has-text("Accept All")',
    'button:has-text("Alle ablehnen")',
    'button:has-text("Alle akzeptieren")',
    '[id*="onetrust"] button',
  ];
  for (const sel of cookieBtns) {
    const btn = await page.$(sel).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1500);
      console.log(`  ✅ SmartRecruiters cookie consent dismissed`);
      break;
    }
  }
}

// ── SmartRecruiters Apply Button Detection ─────────────────────────────────────
/**
 * Find and click the SR "Apply" / "I'm interested" button on the job posting page.
 * SR companies customise button text — Wise uses "I'm interested" and links to /oneclick-ui/.
 * 
 * @param {import('playwright').Page} page
 * @returns {boolean} true if Apply button was found and clicked
 */
export async function findAndClickSRApplyButton(page) {
  console.log(`  🔍 Looking for SR Apply button (waiting for SPA render)...`);

  // Wait for SR React app to fully mount (up to 10s, 5 retries × 2s)
  let srApplyBtn = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(2000);

    // Try multiple selectors — SR companies customize button text!
    // Wise uses "I'm interested", others use "Apply", "Apply now", etc.
    srApplyBtn = await page.$(
      '[data-qa="btn-apply"], a[data-qa="btn-apply"], button[data-qa="btn-apply"], '
      + 'a[href*="oneclick-ui"], '
      + 'a:has-text("I\'m interested"), button:has-text("I\'m interested"), '
      + 'a:has-text("Apply"), button:has-text("Apply"), '
      + 'a:has-text("Apply now"), button:has-text("Apply Now"), '
      + 'a:has-text("Jetzt bewerben"), button:has-text("Jetzt bewerben"), '
      + 'a:has-text("Ich bin interessiert"), button:has-text("Ich bin interessiert")'
    ).catch(() => null);

    if (srApplyBtn && await srApplyBtn.isVisible().catch(() => false)) break;

    // Scroll to trigger lazy-loading
    if (attempt === 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3)).catch(() => {});
    }
    if (attempt === 2) {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    }

    srApplyBtn = null;
  }

  // Found via Playwright selector
  if (srApplyBtn && await srApplyBtn.isVisible().catch(() => false)) {
    const applyBtnText = await srApplyBtn.textContent().catch(() => 'Apply');
    console.log(`  🎯 Clicking SR Apply button: "${applyBtnText.trim()}"...`);
    await srApplyBtn.click();
    await page.waitForTimeout(4000);
    console.log(`  ✅ Navigated to application form (URL: ${page.url()})`);
    return true;
  }

  // Fallback: Try JavaScript click on any element with apply-related attributes or text
  const jsClicked = await page.evaluate(() => {
    const applyEl = document.querySelector('[data-qa="btn-apply"]') ||
                   document.querySelector('a[href*="oneclick-ui"]') ||
                   document.querySelector('a[href*="applying"]') ||
                   document.querySelector('a[href*="application"]');
    if (applyEl) {
      applyEl.click();
      return applyEl.textContent?.trim()?.substring(0, 40) || 'found';
    }
    // Also try links with "interested" text
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const text = (link.innerText || '').toLowerCase();
      if (text.includes('interested') || text.includes('apply') || text.includes('bewerben')) {
        link.click();
        return link.innerText?.trim()?.substring(0, 40) || 'found';
      }
    }
    return null;
  }).catch(() => null);

  if (jsClicked) {
    console.log(`  🎯 JS-clicked SR Apply element: "${jsClicked}"`);
    await page.waitForTimeout(4000);
    return true;
  }

  // Last resort: try direct /applying navigation (may not work for oneclick-ui)
  const currentUrl = page.url();
  if (currentUrl.includes('jobs.smartrecruiters.com') && !currentUrl.includes('applying')) {
    // Log all links on the page to debug
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.offsetParent !== null)
        .map(a => ({ text: (a.innerText || '').trim().substring(0, 40), href: a.href.substring(0, 100), qa: a.getAttribute('data-qa') || '' }))
        .slice(0, 10);
    }).catch(() => []);
    console.log(`  🔗 Page links (${links.length}):`);
    for (const l of links) {
      console.log(`    → "${l.text}" href="${l.href}" qa="${l.qa}"`);
    }

    console.log(`  🔀 No Apply button found — trying direct /applying navigation`);
    const applyFormUrl = currentUrl.replace(/\/?$/, '/applying');
    await page.goto(applyFormUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  return false;
}

// ── SmartRecruiters Oneclick-UI Consent + Form Render ──────────────────────────
/**
 * After navigating to the oneclick-ui page, handle cookie consent (again)
 * and wait for the SR SPA form to render.
 * 
 * @param {import('playwright').Page} page
 */
export async function handleSRFormPageConsent(page) {
  if (!page.url().includes('smartrecruiters.com')) return;

  // Click "Accept All" on cookie banner (may appear again on oneclick-ui page)
  const acceptBtn = await page.$('button#onetrust-accept-btn-handler').catch(() => null);
  if (acceptBtn && await acceptBtn.isVisible().catch(() => false)) {
    await acceptBtn.click();
    console.log(`  🍪 Clicked "Accept All" on cookie banner`);
    await page.waitForTimeout(2000);
  } else {
    // Try OneTrust API as fallback
    await page.evaluate(() => {
      if (typeof OneTrust !== 'undefined' && OneTrust.AllowAll) {
        try { OneTrust.AllowAll(); } catch(e) {}
      }
    }).catch(() => {});
    console.log(`  🍪 OneTrust consent accepted via API`);
    await page.waitForTimeout(2000);
  }

  // CSS-hide (NOT DOM removal) OneTrust overlays
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      #onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk,
      .onetrust-pc-dark-filter, #ot-sdk-cookie-policy {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      body, html {
        overflow: auto !important;
      }
    `;
    document.head.appendChild(style);
  }).catch(() => {});

  // Wait for SR SPA to render
  console.log(`  ⏳ Waiting for SR application form to render...`);
  await page.waitForTimeout(5000);

  // Check if any form elements appeared
  const formCheck = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select, button[data-qa]');
    const visibleInputs = Array.from(inputs).filter(el => el.offsetParent !== null && el.offsetWidth > 0);
    const bodyText = document.body.innerText.substring(0, 500);
    return {
      totalInputs: inputs.length,
      visibleInputs: visibleInputs.length,
      visibleTypes: visibleInputs.slice(0, 5).map(el => `${el.tagName}[${el.type || el.getAttribute('data-qa') || ''}]`),
      bodyPreview: bodyText.replace(/\s+/g, ' ').substring(0, 300),
      url: window.location.href
    };
  }).catch(() => ({ totalInputs: 0, visibleInputs: 0, visibleTypes: [], bodyPreview: 'error', url: '' }));

  console.log(`  📋 SR page state: ${formCheck.visibleInputs} visible inputs, URL: ${formCheck.url}`);
  console.log(`  📋 Input types: ${formCheck.visibleTypes.join(', ') || 'none'}`);
  if (formCheck.visibleInputs === 0) {
    console.log(`  📋 Body preview: ${formCheck.bodyPreview}`);
    console.log(`  ⏳ No form elements found — waiting 8s more for SPA...`);
    await page.waitForTimeout(8000);
  }
}

// ── Per-Step Safety Check ──────────────────────────────────────────────────────
/**
 * Safety check at the top of each form step.
 * Dismisses any lingering OneTrust overlay before filling fields.
 * 
 * @param {import('playwright').Page} page
 * @param {number} stepCount - Current step number (for logging)
 */
export async function ensureNoOverlay(page, stepCount) {
  const otOverlay = await page.$('#onetrust-consent-sdk').catch(() => null);
  if (otOverlay && await otOverlay.isVisible().catch(() => false)) {
    console.log(`  🍪 OneTrust overlay still visible on step ${stepCount} — force-removing`);
    for (const sel of ['button.save-preference-btn-handler', 'button:has-text("Confirm My Choices")', '#accept-recommended-btn-handler']) {
      const b = await page.$(sel).catch(() => null);
      if (b && await b.isVisible().catch(() => false)) {
        await b.click(); await page.waitForTimeout(1500); break;
      }
    }
    await page.evaluate(() => {
      const ot = document.getElementById('onetrust-consent-sdk');
      if (ot) ot.remove();
      const bd = document.querySelector('.onetrust-pc-dark-filter');
      if (bd) bd.remove();
      document.body.style.overflow = 'auto';
    }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}
