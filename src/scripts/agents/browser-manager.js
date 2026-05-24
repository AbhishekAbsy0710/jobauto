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
  const isLocal = process.env.LOCAL_RUN === 'true';
  const isHeaded = opts.headed || process.env.HEADED === 'true' || isLocal;
  if (isLocal && isHeaded) console.log('  🖥️  Headed mode (LOCAL_RUN) — browser window will be visible for captcha solving');
  const browser = await chromium.launch({
    headless: !isHeaded,
    slowMo: isHeaded ? 100 : 150,
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

  // Erase navigator.webdriver on every new page to defeat bot detection (including SR oneclick-ui)
  await context.addInitScript(() => {
    // Core: remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // Chrome runtime mock (SR checks this)
    window.chrome = {
      runtime: { onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => {}, id: 'mocked' },
      loadTimes: () => ({  startLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000 + 0.1 }),
      csi: () => ({ startE: Date.now(), onloadT: Date.now() + 100 }),
    };

    // Plugins array (headless has 0 plugins)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        arr.refresh = () => {};
        return arr;
      }
    });

    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Connection API (some bot detectors check this)
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
      });
    }

    // Permissions API mock
    const origQuery = window.Permissions?.prototype?.query;
    if (origQuery) {
      window.Permissions.prototype.query = (params) =>
        params?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery.call(navigator.permissions, params);
    }

    // WebGL renderer (headless has different value)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
  });
  
  // Set a reasonable timeout — 10s for async form rendering
  context.setDefaultTimeout(opts.timeout || 10000);

  return context;
}

// ── Close Browser ──────────────────────────────────────────────────────────────
export async function closeBrowser(browser) {
  try { await browser.close(); } catch {}
}
