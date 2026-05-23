/**
 * agents/consent-handler.js — Cookie & GDPR Consent Agent
 * 
 * Handles ALL cookie consent flows:
 * - Generic cookie banners (Accept All, Got it, etc.)
 * - OneTrust preference center (banner vs full overlay)
 * - SmartRecruiters GDPR consent (checkboxes + Confirm My Choices)
 * - Per-step safety checks (dismiss lingering overlays)
 * 
 * Exports:
 *   - dismissCookieBanners(page) — generic cookie banner dismiss
 *   - handleSmartRecruitersConsent(page) — full SR GDPR + OneTrust flow
 *   - ensureNoOverlay(page, stepCount) — safety check per form step
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

// ── SmartRecruiters GDPR + OneTrust Full Flow ──────────────────────────────────
/**
 * Handles the SmartRecruiters consent flow which uses OneTrust:
 * 1. Accept cookies via OneTrust API (preserves GDPR form)
 * 2. Check GDPR consent checkboxes
 * 3. Click "Confirm My Choices" to close overlay
 * 4. Nuclear fallback: force-remove OneTrust DOM if stuck
 * 
 * @param {import('playwright').Page} page
 * @returns {boolean} true if consent was handled
 */
export async function handleSmartRecruitersConsent(page) {
  const isSmartRecruiters = page.url().includes('smartrecruiters.com');
  if (!isSmartRecruiters) return false;

  // ── Step 0: Accept OneTrust cookies via API ──
  // Don't remove DOM — GDPR form checkboxes are inside the OneTrust container
  await page.evaluate(() => {
    if (typeof OneTrust !== 'undefined') {
      try { if (OneTrust.AllowAll) OneTrust.AllowAll(); } catch(e) {}
      try { if (OneTrust.Close) OneTrust.Close(); } catch(e) {}
    }
    // Only remove the cookie BANNER, NOT the full consent SDK
    const banner = document.getElementById('onetrust-banner-sdk');
    if (banner) banner.remove();
    const backdrop = document.querySelector('.onetrust-pc-dark-filter');
    if (backdrop) backdrop.remove();
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
  }).catch(() => {});
  await page.waitForTimeout(1000);
  console.log(`  🍪 OneTrust cookie banner dismissed (GDPR form preserved)`);

  // ── Step 1: Check GDPR consent checkboxes ──
  const gdprCheckboxSelectors = [
    '#vendor-search-handler',
    '#chkbox-id',
    '#select-all-hosts-groups-handler',
    '#select-all-vendor-groups-handler',
    '#select-all-vendor-leg-handler',
  ];
  let gdprFound = false;
  await page.waitForTimeout(1500);
  for (const sel of gdprCheckboxSelectors) {
    const cb = await page.$(sel).catch(() => null);
    if (cb) {
      const isChecked = await cb.isChecked().catch(() => false);
      if (!isChecked) {
        await cb.scrollIntoViewIfNeeded().catch(() => {});
        await cb.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
      gdprFound = true;
    }
  }

  if (!gdprFound) {
    console.log(`  ℹ️  No GDPR checkboxes found — skipping consent step`);
    return false;
  }

  console.log(`  ✅ SmartRecruiters GDPR consent checkboxes accepted`);
  await page.waitForTimeout(800);

  // ── Step 2: Click "Confirm My Choices" to save consent and close overlay ──
  // The GDPR checkboxes ARE OneTrust preference center controls.
  const confirmSelectors = [
    'button.save-preference-btn-handler',
    '#accept-recommended-btn-handler',
    'button:has-text("Confirm My Choices")',
    'button:has-text("Save Settings")',
    'button:has-text("Save and Exit")',
    'button:has-text("Auswahl bestätigen")',
    'button[data-qa="action-button"]',         // SR fallback
    'button:has-text("Continue")',
    'button[type="submit"]',
  ];
  let clicked = false;
  for (const sel of confirmSelectors) {
    const btns = await page.$$(sel).catch(() => []);
    for (const btn of btns) {
      if (!await btn.isVisible().catch(() => false)) continue;
      const txt = (await btn.textContent().catch(() => '')).toLowerCase().trim();
      if (txt.includes('without') || txt.includes('ohne') || txt.includes('reject')) continue;
      console.log(`  ➡️  Consent: clicking "${txt}"`);
      await btn.click();
      clicked = true;
      break;
    }
    if (clicked) break;
  }

  if (clicked) {
    // Wait for OneTrust overlay to disappear (reveals the actual SR form)
    for (let w = 0; w < 10; w++) {
      await page.waitForTimeout(500);
      const otPC = await page.$('#onetrust-pc-sdk').catch(() => null);
      const otVis = otPC ? await otPC.isVisible().catch(() => false) : false;
      if (!otVis) break;
    }
    console.log(`  ✅ Consent overlay closed — proceeding to application form`);
  } else {
    console.log(`  ⚠️ No consent confirm button found — trying to proceed anyway`);
  }

  await page.waitForTimeout(2000);
  // Debug screenshot
  await page.screenshot({ path: 'debug_pre_form.png', fullPage: true }).catch(() => {});

  // ── Step 3: Nuclear fallback — if overlay persists, force-remove ──
  const onOTPrefs = await page.$('input[name="ot-group-id-C0002"]').catch(() => null);
  if (onOTPrefs) {
    console.log(`  🍪 OneTrust overlay still present — force-removing`);
    await page.evaluate(() => {
      for (const sel of ['#onetrust-consent-sdk', '#onetrust-pc-sdk', '.onetrust-pc-dark-filter']) {
        const el = document.querySelector(sel);
        if (el) el.remove();
      }
      document.body.style.overflow = 'auto';
      document.documentElement.style.overflow = 'auto';
    }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  return true;
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
