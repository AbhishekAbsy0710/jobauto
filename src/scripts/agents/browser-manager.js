/**
 * agents/browser-manager.js — Browser Lifecycle Agent
 * 
 * Manages Chromium launch, anti-detect context, and page creation.
 * 
 * Exports:
 *   - createBrowser(opts) — launch Chromium with anti-detect config
 *   - createContext(browser, opts) — create browser context with stealth
 *   - closeBrowser(browser) — graceful shutdown
 */

import { chromium } from 'playwright';

// ── Launch Browser ────────────────────────────────────────────────────────────
/**
 * Launch Chromium with anti-detection flags.
 * @param {object} opts
 * @param {boolean} opts.headed - Show browser window (default: false)
 * @returns {import('playwright').Browser}
 */
export async function createBrowser(opts = {}) {
  const isHeaded = opts.headed || process.env.HEADED === 'true';
  const browser = await chromium.launch({
    headless: !isHeaded,
    slowMo: isHeaded ? 300 : 150,
    timeout: 30000,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

// ── Create Anti-Detect Context ────────────────────────────────────────────────
/**
 * Create a browser context with stealth settings.
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {number} opts.timeout - Default timeout in ms (default: 10000)
 * @returns {import('playwright').BrowserContext}
 */
export async function createContext(browser, opts = {}) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    geolocation: { longitude: 11.58, latitude: 48.14 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  // Erase navigator.webdriver on every new page to defeat basic bot detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  
  // Set a reasonable timeout — 10s for async form rendering
  context.setDefaultTimeout(opts.timeout || 10000);

  return context;
}

// ── Close Browser ──────────────────────────────────────────────────────────────
export async function closeBrowser(browser) {
  try { await browser.close(); } catch {}
}
