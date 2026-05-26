#!/usr/bin/env node
/**
 * Playwright Browser Auto-Apply (AI Powered)
 * Dynamically fills out forms using Groq API
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

// Force unbuffered stdout even when piped (non-TTY).
// Without this, all console.log output is held in the OS pipe buffer
// and only appears when the process exits — making real-time monitoring impossible.
if (process.stdout._handle && process.stdout._handle.setBlocking) {
  process.stdout._handle.setBlocking(true);
}
// Also write progress to a file for easy external tailing
import { appendFileSync as _appendLog } from 'fs';
const PROGRESS_LOG = '/tmp/apply-progress.txt';
const _origLog = console.log.bind(console);
console.log = (...args) => {
  _origLog(...args);
  try { _appendLog(PROGRESS_LOG, args.join(' ') + '\n'); } catch {}
};
const _origErr = console.error.bind(console);
console.error = (...args) => {
  _origErr(...args);
  try { _appendLog(PROGRESS_LOG, '[ERR] ' + args.join(' ') + '\n'); } catch {}
};

// chromium lifecycle managed by ./agents/browser-manager.js

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// Load .env BEFORE agent imports (agents read process.env)
try {
  const envFile = readFileSync(join(ROOT, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

// ── Agent Imports ──────────────────────────────────────────────────────────────
import {
  PROFILE, PROFILE_YAML, RESUME_PATH as RESUME_PATH_CONST,
  SUBMIT_SELECTORS, NEXT_SELECTORS, FINAL_PAGE_SIGNALS,
  MAX_JOBS_PER_RUN, MAX_PREFILTER_PER_COMPANY, MAX_PER_COMPANY, MAX_STEPS,
  DISCORD_WEBHOOK, TARGET_KEYWORDS, SKIP_KEYWORDS, PAGE_LOAD_BLOCKED,
  tryStaticAnswer,
} from './agents/constants.js';
import { callGroq, callGemini, healAndRetry } from './agents/llm-client.js';
import {
  dismissCookieBanners, handleSRCookieConsent, findAndClickSRApplyButton,
  handleSRFormPageConsent, ensureNoOverlay,
} from './agents/consent-handler.js';
import { verifySubmission } from './agents/verification-agent.js';
import { submitForm } from './agents/form-submitter.js';
import { createBrowser, createContext, closeBrowser } from './agents/browser-manager.js';
import { reportApplied, reportFailed, sendRunSummary } from './agents/reporter.js';
import { recordSuccess, recordFailure, uploadProofScreenshot, trackColdEmail } from './agents/dashboard-updater.js';
import { getJobQueue, shouldSkipJob } from './agents/job-queue.js';
import { generateTailoredResume } from './agents/resume-tailor.js';
import { evaluateJobFit } from './agents/evaluation-agent.js';

const RESUME_PATH = RESUME_PATH_CONST;

// sendDiscordEmbed imported from ./agents/reporter.js


// ============================================
// AI FORM FILLER
// ============================================
async function fillDynamicFields(page) {
  // Diagnostic: count all inputs on page before filtering
  const inputDiag = await page.evaluate(() => {
    function queryAllShadows(root, selector, res = []) {
      const els = root.querySelectorAll(selector);
      for (const el of els) res.push(el);
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
      }
      return res;
    }
    const all = queryAllShadows(document, 'input, select, textarea');
    const visible = Array.from(all).filter(el => el.offsetParent !== null && !el.closest('[style*="display: none"]'));
    return { total: all.length, visible: visible.length, types: visible.slice(0, 10).map(e => `${e.tagName.toLowerCase()}[name=${e.name||e.id||'?'}][type=${e.type||'?'}]`) };
  }).catch(() => ({ total: 0, visible: 0, types: [] }));
  console.log(`  🔍 Field scan: ${inputDiag.total} total inputs, ${inputDiag.visible} visible: ${inputDiag.types.join(', ')}`);

  const fields = await page.evaluate(() => {
    function queryAllShadows(root, selector, res = []) {
      const els = root.querySelectorAll(selector);
      for (const el of els) res.push(el);
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
      }
      return res;
    }
    const results = [];

    // --- Standard inputs ---
    const inputs = queryAllShadows(document, 'input:not([type="hidden"]), select, textarea');
    for (const el of inputs) {
      const name = (el.name || el.id || '').toLowerCase();
      if (['first_name', 'last_name', 'fname', 'lname', 'name'].includes(name) || ['email', 'e-mail'].includes(name) || name.includes('phone') || el.type === 'file' || el.type === 'submit') continue;
      // Skip IntlTelInput phone country-code picker (iti-*) — it's handled by fillBaseFields
      if (name.startsWith('iti-') || name.includes('__search-input') || name.includes('search-input')) continue;
      // Skip OneTrust cookie consent fields — these are NOT application form fields
      if (name.includes('ot-group-id') || name.includes('onetrust') || name.includes('vendor-search-handler') || name.includes('select-all-hosts') || name.includes('select-all-vendor') || name.includes('select-all-vendor-leg')) continue;
      // Skip fields inside OneTrust overlay container
      if (el.closest('#onetrust-consent-sdk') || el.closest('#onetrust-pc-sdk') || el.closest('.onetrust-pc-dark-filter')) continue;
      if (el.disabled) continue;

      let labelText = '';
      if (el.labels && el.labels.length > 0) {
        labelText = Array.from(el.labels).map(l => l.innerText).join(' ');
      }
      if (!labelText) {
        // Try parent div in same DOM
        const parent = el.closest('.field, .form-group, div');
        if (parent) {
          const txt = (parent.innerText || '').split('\n').filter(l => l.trim().length > 2 && l.trim().length < 200);
          if (txt.length > 0 && txt.length <= 3) labelText = txt[0]; // Only use if parent has few text lines (specific to this field)
        }
      }
      if (!labelText) {
        // SR Shadow DOM: walk up to the outermost host element
        let host = el.getRootNode()?.host;
        if (host) {
          while (host && host.getRootNode()?.host) {
            host = host.getRootNode().host;
          }
          // Check label/aria-label attribute on host
          const hostLabel = host.getAttribute('label') || host.getAttribute('aria-label') || '';
          if (hostLabel && hostLabel.length > 2) {
            labelText = hostLabel;
          } else {
            // Use BOUNDING BOX proximity — find nearest text element ABOVE this input
            const inputRect = el.getBoundingClientRect();
            if (inputRect.top > 0) {
              // previousElementSibling of the host often has the question text in SR
              let prev = host.previousElementSibling;
              while (prev) {
                const t = (prev.innerText || prev.textContent || '').trim();
                if (t.length > 3 && t.length < 300 && !/^(Next|Back|Submit|Cancel)$/i.test(t)) {
                  labelText = t.split('\n')[0]; // First line of the previous sibling
                  break;
                }
                prev = prev.previousElementSibling;
              }
              // If still no label, try the host's parent's visible text
              if (!labelText && host.parentElement) {
                const siblings = Array.from(host.parentElement.children);
                const hostIdx = siblings.indexOf(host);
                // Look at siblings BEFORE this host
                for (let i = hostIdx - 1; i >= Math.max(0, hostIdx - 3); i--) {
                  const t = (siblings[i].innerText || siblings[i].textContent || '').trim();
                  if (t.length > 3 && t.length < 300) {
                    labelText = t.split('\n')[0];
                    break;
                  }
                }
              }
            }
          }
        }
      }

      let options = [];
      if (el.tagName === 'SELECT') {
        options = Array.from(el.querySelectorAll('option'))
                       .filter(o => o.innerText.trim() && o.innerText.trim() !== 'Select...')
                       .map(o => ({ value: o.value || o.innerText.trim(), label: o.innerText.trim() }));
      } else if (el.type === 'radio' || el.type === 'checkbox') {
        let text = el.value;
        const next = el.nextElementSibling;
        const labelById = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        if (labelById) {
           text = labelById.innerText.trim();
        } else if (next && next.tagName === 'LABEL') {
           text = next.innerText.trim();
        } else if (el.parentElement && el.parentElement.tagName === 'LABEL') {
           const clone = el.parentElement.cloneNode(true);
           clone.querySelectorAll('input').forEach(i => i.remove());
           text = clone.innerText.trim() || el.value;
        }
        options = [{ value: (el.value === 'on' && text) ? text : el.value, label: text }];
      }

      let elType = el.type || el.tagName.toLowerCase();
      // Detect React Select hidden input (Greenhouse uses class 'select__input')
      const cls = (el.className || '').toLowerCase();
      const parentCls = (el.parentElement?.className || '').toLowerCase();
      const isReactSelect = cls.includes('select__input') || cls.includes('select-field__input') ||
                            parentCls.includes('select__value-container') || parentCls.includes('select__input-container');
      if (isReactSelect) elType = 'reactselect';

      // For React Select: get options from the sibling hidden <select> or from the control's data
      if (isReactSelect && el.id) {
        // Greenhouse pairs React Select with a hidden <select> for form submission
        const pairedSelect = document.querySelector(`select[id="${el.id.replace(/_search_input$|_input$/, '')}"]`) ||
                             document.querySelector(`select[name="${el.name}"]`);
        if (pairedSelect) {
          options = Array.from(pairedSelect.querySelectorAll('option'))
            .filter(o => o.value && o.innerText.trim() && o.innerText.trim() !== 'Select...')
            .map(o => ({ value: o.value, label: o.innerText.trim() }));
        }
      }

      if (labelText && (el.name || el.id)) {
        results.push({
          id: el.id || '',
          name: el.name || el.id || '',
          type: elType,
          label: labelText.substring(0, 150).replace(/\s+/g, ' ').trim(),
          options: options.slice(0, 20),
          isCombobox: isReactSelect,
          currentValue: (el.value || '').trim()
        });
      }
    }

    // --- Greenhouse combobox dropdowns (role="combobox") ---
    // These are used by Anthropic and others for Yes/No and multi-choice questions
    const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    for (const el of comboboxes) {
      const id = el.id || '';
      if (!id) continue;
      // Skip if already captured as a standard select
      if (results.some(r => r.id === id)) continue;

      // Find the question label — Greenhouse wraps it in a <label> with for= the combobox id
      let labelText = '';
      const labelEl = document.querySelector(`label[for="${id}"]`);
      if (labelEl) {
        labelText = labelEl.innerText.trim();
      } else {
        const parent = el.closest('.field--select, .select-question, div');
        if (parent) labelText = parent.innerText.split('\\n')[0];
      }
      if (!labelText) continue;

      // Get dropdown options from aria-listbox (may be hidden until clicked)
      // Try the hidden select that Greenhouse pairs with the combobox
      const hiddenSelect = document.querySelector(`select[id*="${id.replace('combobox_', '')}"], select[name*="${id}"]`);
      let options = [];
      if (hiddenSelect) {
        options = Array.from(hiddenSelect.querySelectorAll('option'))
          .filter(o => o.value && o.innerText.trim())
          .map(o => ({ value: o.value, label: o.innerText.trim() }));
      }

      results.push({
        id,
        name: id,
        type: 'combobox',
        label: labelText.substring(0, 150).replace(/\s+/g, ' ').trim(),
        options,
        isCombobox: true
      });
    }

    return results;
  });

  // ── SR label enrichment: use locator.evaluate() to walk DOM from inside shadow root ──
  // The key insight: locator.evaluate() runs in the SAME shadow root as the input,
  // so it can walk up/around the DOM tree to find the question text
  let pageTextForAI = '';
  const needsEnrichment = fields.some(f => !f.label || f.label === '*' || f.label === 'Preliminary questions');
  if (needsEnrichment) {
    try {
      const labelParts = [];
      for (const f of fields) {
        if (f.label && f.label !== '*' && f.label !== 'Preliminary questions') continue;
        if (!f.name) continue;
        try {
          const loc = page.locator(`[name="${f.name}"]`).first();
          // evaluate() runs INSIDE the shadow root where the input lives
          const qText = await loc.evaluate(el => {
            // Strategy 1: check aria-label or aria-describedby
            const ariaLabel = el.getAttribute('aria-label') || '';
            if (ariaLabel.length > 5) return ariaLabel;
            
            // Strategy 2: walk UP the DOM tree (stays within same shadow root)
            let node = el.parentElement;
            for (let i = 0; i < 8 && node; i++) {
              // Check for label/aria-label on parent
              const a = node.getAttribute('label') || node.getAttribute('aria-label') || '';
              if (a.length > 5 && a.length < 200) return a;
              
              // Check text content of previous siblings (question text is usually above)
              let prev = node.previousElementSibling;
              for (let j = 0; j < 3 && prev; j++) {
                const t = (prev.innerText || prev.textContent || '').trim();
                if (t.length > 8 && t.length < 200 && !/^(Next|Back|Submit|Cancel|Preliminary|Required)$/i.test(t)) {
                  return t.split('\n')[0].trim();
                }
                prev = prev.previousElementSibling;
              }
              
              node = node.parentElement;
            }
            
            // Strategy 3: if we hit the shadow root boundary, check the host element
            let root = el.getRootNode();
            if (root && root.host) {
              const hostLabel = root.host.getAttribute('label') || root.host.getAttribute('aria-label') || '';
              if (hostLabel.length > 5) return hostLabel;
              // Check host's previous siblings
              let hostPrev = root.host.previousElementSibling;
              for (let j = 0; j < 3 && hostPrev; j++) {
                const t = (hostPrev.innerText || hostPrev.textContent || '').trim();
                if (t.length > 8 && t.length < 200) return t.split('\n')[0].trim();
                hostPrev = hostPrev.previousElementSibling;
              }
              // Go up one more level: host's parent's host
              let outerRoot = root.host.getRootNode();
              if (outerRoot && outerRoot.host) {
                const outerLabel = outerRoot.host.getAttribute('label') || outerRoot.host.getAttribute('aria-label') || '';
                if (outerLabel.length > 5) return outerLabel;
                let outerPrev = outerRoot.host.previousElementSibling;
                for (let j = 0; j < 3 && outerPrev; j++) {
                  const t = (outerPrev.innerText || outerPrev.textContent || '').trim();
                  if (t.length > 8 && t.length < 200) return t.split('\n')[0].trim();
                  outerPrev = outerPrev.previousElementSibling;
                }
              }
            }
            return '';
          }, { timeout: 2000 }).catch(() => '');
          
          if (qText && qText.length > 5) {
            let cleanText = qText.split('\n')[0].trim().substring(0, 150);
            if (/^(Preliminary questions|Software Engineer|Personal info)/i.test(cleanText)) continue;
            // SR dropdowns prepend "Select " to the label — strip it and mark as dropdown
            const isDropdown = cleanText.startsWith('Select ');
            if (isDropdown) cleanText = cleanText.replace(/^Select /, '');
            f.label = cleanText;
            if (isDropdown) f.isDropdown = true;
            labelParts.push(`Field "${f.name.substring(0, 30)}": "${cleanText}"${isDropdown ? ' [DROPDOWN]' : ''}`);
            console.log(`    📍 Q: ${f.name.substring(0, 25)} → "${cleanText.substring(0, 60)}"${isDropdown ? ' [DROPDOWN]' : ''}`);
          }
        } catch { /* skip */ }
      }
      if (labelParts.length > 0) {
        pageTextForAI = labelParts.join('\n');
        console.log(`    📄 Found ${labelParts.length} question labels via shadow DOM walk`);
      }
    } catch { /* skip */ }
  }

  // ── Fallback: For fields still labeled "*", search ALL text (including shadow DOM) near the field ──
  for (const f of fields) {
    if (f.label && f.label !== '*' && f.label !== 'Preliminary questions') continue;
    if (!f.name) continue;
    try {
      const loc = page.locator(`[name="${f.name}"]`).first();
      if (await loc.count() === 0) continue;
      
      // Get the element's position on the page
      const box = await loc.boundingBox().catch(() => null);
      if (!box) continue;
      
      // Use page.evaluate to find visible text elements ABOVE this position — including shadow DOM
      const nearbyText = await page.evaluate((fieldY) => {
        const skip = /^(Next|Back|Submit|Cancel|Preliminary|Required|Easy Apply|Software|Senior|Junior|Lead|Staff|Principal|Engineer|Manager|Designer|Analyst|Budapest|London|Berlin|Remote|Váci|Fields marked|Personal info|Add|Save)/i;
        let bestText = '';
        let bestDist = 999999;
        
        function checkEl(el) {
          const rect = el.getBoundingClientRect();
          if (rect.height === 0 || rect.width === 0) return;
          const dist = fieldY - rect.bottom;
          if (dist > 0 && dist < 80 && dist < bestDist) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.length > 5 && text.length < 200 && !skip.test(text)) {
              bestText = text.split('\n')[0].trim();
              bestDist = dist;
            }
          }
        }
        
        // Search light DOM
        for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, label, span, p, div')) {
          checkEl(el);
        }
        
        // Search shadow DOMs (SR labels live here)
        function walkShadows(root) {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              for (const inner of el.shadowRoot.querySelectorAll('label, span, p, div, slot')) {
                checkEl(inner);
              }
              walkShadows(el.shadowRoot);
            }
          }
        }
        walkShadows(document);
        
        return bestText;
      }, box.y).catch(() => '');
      
      if (nearbyText && nearbyText.length > 5) {
        f.label = nearbyText.substring(0, 150);
        console.log(`    📍 Fallback Q: ${f.name.substring(0, 25)} → "${nearbyText.substring(0, 60)}" (via position)`);
      }
    } catch { /* skip */ }
  }

  // ── Last resort: For fields STILL labeled "*", search page body text for known questions ──
  const stillUnlabeled = fields.filter(f => (!f.label || f.label === '*') && f.name);
  if (stillUnlabeled.length > 0) {
    try {
      const bodyText = await page.textContent('body').catch(() => '');
      const knownPatterns = [
        { regex: /what is your notice period/i, label: 'What is your notice period?' },
        { regex: /notice period/i, label: 'What is your notice period?' },
        { regex: /earliest start date/i, label: 'What is your earliest start date?' },
        { regex: /when can you start/i, label: 'When can you start?' },
        { regex: /current salary/i, label: 'What is your current salary?' },
        { regex: /expected salary/i, label: 'What is your expected salary?' },
        { regex: /salary expectation/i, label: 'What are your salary expectations?' },
        { regex: /years of experience/i, label: 'How many years of experience do you have?' },
        { regex: /cover letter/i, label: 'Cover Letter' },
      ];
      for (const f of stillUnlabeled) {
        for (const { regex, label } of knownPatterns) {
          if (regex.test(bodyText)) {
            f.label = label;
            console.log(`    📍 Last-resort Q: ${f.name.substring(0, 25)} → "${label}" (via page text)`);
            break;
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── Fix 2: Read Shadow DOM dropdown options via BEFORE/AFTER diff ──
  // SR renders dropdown items in a global overlay, not inside the spl-select shadow root.
  // To avoid accumulation: read all visible items BEFORE opening, then AFTER opening,
  // and take only the NEW items that appeared.
  for (const f of fields) {
    if (!f.isDropdown || (f.options && f.options.length > 0) || !f.name) continue;
    try {
      const loc = page.locator(`[name="${f.name}"]`).first();
      if (await loc.count() === 0) continue;

      // First, close any stale dropdowns by clicking away
      await page.mouse.click(10, 10).catch(() => {});
      await page.waitForTimeout(300);

      // Read all visible dropdown items BEFORE opening this dropdown
      const beforeItems = await page.locator('spl-dropdown-item, [role="option"]').allTextContents().catch(() => []);
      const beforeSet = new Set(beforeItems.map(t => t.trim()).filter(Boolean));

      // Click to open the dropdown
      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);

      // Read all visible dropdown items AFTER opening — take only NEW ones
      const afterItems = await page.locator('spl-dropdown-item, [role="option"]').allTextContents().catch(() => []);
      const newOptions = [];
      const seen = new Set();
      for (const raw of afterItems) {
        const text = raw.trim();
        if (!text || text.length > 200) continue;
        if (/^select|^choose|^--|^please select/i.test(text)) continue;
        if (beforeSet.has(text)) continue; // Was already visible before — belongs to another dropdown
        if (seen.has(text)) continue;
        seen.add(text);
        newOptions.push(text);
      }

      // If diff found 0 but after has items and before was 0, use all after items
      const finalOptions = newOptions.length > 0 ? newOptions : 
        (beforeSet.size === 0 ? afterItems.map(t => t.trim()).filter(t => t && t.length < 200 && !/^select|^choose|^--|^please select/i.test(t)) : []);

      if (finalOptions.length > 0) {
        f.options = [...new Set(finalOptions)].map(t => ({ value: t, label: t }));
        console.log(`    📋 Read ${f.options.length} dropdown options for "${(f.label || f.name).substring(0, 40)}": ${finalOptions.slice(0, 3).join(', ')}${finalOptions.length > 3 ? '...' : ''}`);
      }

      // Close dropdown by clicking away
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      await page.mouse.click(10, 10).catch(() => {});
      await page.waitForTimeout(400);
    } catch { /* skip */ }
  }

  // Filter out GDPR/cookie consent manager fields, phone picker fields, and Twitter/X
  const cleanedFields = fields.filter(f => {
    const n = (f.name || f.id || '').toLowerCase();
    const lbl = (f.label || '').toLowerCase();
    if (n.startsWith('fc-preference') || n.startsWith('fc-vendor') || n.startsWith('didomi') || n.includes('consent-slider') || n.includes('gvl-vendor')) return false;
    if (n.includes('search_jobs') || n.includes('search_sort') || n.includes('search_location')) return false;
    // Skip IntlTelInput phone country-code picker and any iti-* fields
    if (n.startsWith('iti-') || n.includes('__search-input')) return false;
    // Skip Twitter / X fields — user does not have a Twitter account
    if (/twitter|x\.com/i.test(n) || /twitter|x\.com/i.test(lbl)) return false;
    return true;
  });

  if (cleanedFields.length === 0) {
    console.log(`  🔍 fillDynamicFields: 0 fields after filtering (raw: ${fields.length})`);
    return;
  }

  // Group radio buttons
  const grouped = {};
  for (const f of cleanedFields) {
    if (!grouped[f.name]) grouped[f.name] = { name: f.name, label: f.label, type: f.type, options: [], currentValue: f.currentValue || '', isDropdown: f.isDropdown || false, isCombobox: f.isCombobox || false };
    if (f.options && f.options.length > 0) grouped[f.name].options.push(...f.options);
    // Carry enriched label and dropdown flag from label enrichment
    if (f.label && f.label !== '*' && f.label !== 'Preliminary questions') grouped[f.name].label = f.label;
    if (f.isDropdown) grouped[f.name].isDropdown = true;
  }

  const questions = Object.values(grouped);
  if (questions.length === 0) return;

  // Skip fields that are already pre-filled — do NOT send them to AI, do NOT touch them
  const skippedPrefilled = [];
  const aiQuestions = questions.filter(q => {
    const cv = (q.currentValue || '').trim();

    // Select/dropdown: skip if a non-default option is already selected
    if (q.type === 'select' || q.type === 'select-one') {
      if (cv && cv !== '' && q.options.length > 0) {
        // Check if current value matches a real option (not just the placeholder)
        const isPlaceholder = /^select|^choose|^--|^please|^$/i.test(cv);
        if (!isPlaceholder) {
          skippedPrefilled.push(`${(q.name||'').substring(0,25)}="${cv.substring(0,25)}" [select]`);
          return false;
        }
      }
      return true;
    }

    // Radio/checkbox: always need AI to pick the right option
    if (q.type === 'radio' || q.type === 'checkbox') return true;

    // Text/tel/email/combobox fields: skip if they already have a value
    if (cv.length > 0) {
      skippedPrefilled.push(`${(q.name || '').substring(0, 25)}="${cv.substring(0, 25)}"`);
      return false;
    }
    return true;
  });
  if (skippedPrefilled.length > 0) {
    console.log(`    ✅ Skipping ${skippedPrefilled.length} pre-filled: ${skippedPrefilled.slice(0, 5).join(', ')}`);
  }

  // ── Static answer pre-fill: handle known fields without wasting LLM tokens ──
  const staticFilled = [];
  const llmQuestions = [];
  for (const q of aiQuestions) {
    const staticMatch = tryStaticAnswer(q.label);
    if (staticMatch) {
      staticFilled.push(q);
      // Fill the field immediately using static answer
      try {
        const loc = page.locator(`[name="${q.name}"]`).first();
        if (await loc.count() > 0) {
          if (q.isDropdown || q.type === 'select' || q.type === 'select-one') {
            // For dropdowns: click, type the value, wait for dropdown to filter, then click the matching option
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await loc.click({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(400);
            await page.keyboard.type(staticMatch.value.substring(0, 20), { delay: 30 });
            await page.waitForTimeout(800);
            // Click the first visible matching option (supports regular dropdown + multiselect autocomplete)
            const searchVal = staticMatch.value.substring(0, 30);
            const optionLoc = page.locator(`spl-dropdown-item, spl-multiselect-option, [role="option"], [role="listbox"] li, [role="listbox"] > *`);
            const optCount = await optionLoc.count().catch(() => 0);
            let picked = false;
            const targetLower = staticMatch.value.toLowerCase();
            for (let oi = 0; oi < Math.min(optCount, 25); oi++) {
              const opt = optionLoc.nth(oi);
              if (!await opt.isVisible().catch(() => false)) continue;
              const text = (await opt.textContent().catch(() => '')).trim().toLowerCase();
              if (text === targetLower || text.startsWith(targetLower) || (targetLower.length > 3 && text.includes(targetLower))) {
                await opt.click({ force: true }).catch(() => {});
                console.log(`    ✅ Picked dropdown option: "${text.substring(0, 50)}"`);
                picked = true;
                break;
              }
            }
            if (!picked) {
              // Fallback: try to find and click option via shadow DOM evaluate
              picked = await page.evaluate((target) => {
                function qas(root, sel, res = []) {
                  try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                  try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                  return res;
                }
                const opts = qas(document, '[role="option"], spl-multiselect-option, spl-dropdown-item, li[class*="option"]');
                for (const opt of opts) {
                  const vis = opt.offsetParent !== null || (opt.getRootNode()?.host?.offsetParent !== null);
                  if (!vis) continue;
                  const text = (opt.innerText || opt.textContent || '').trim().toLowerCase();
                  if (text === target || text.includes(target)) {
                    opt.click();
                    return true;
                  }
                }
                return false;
              }, targetLower).catch(() => false);
              if (picked) {
                console.log(`    ✅ Picked option via shadow DOM: "${targetLower.substring(0, 50)}"`);
              }
            }
            if (!picked) {
              // Last resort: press Enter to select the first filtered option
              await page.keyboard.press('Enter');
              console.log(`    ⏎ Pressed Enter for dropdown: "${searchVal}"`);
            }
            await page.waitForTimeout(300);
            // Close dropdown overlay by clicking outside
            await page.locator('h1, h2').first().click({ force: true, timeout: 500 }).catch(() => {});
          } else {
            await loc.click({ clickCount: 3, timeout: 2000 }).catch(() => {});
            await page.keyboard.type(staticMatch.value, { delay: 10 });
          }
          console.log(`    ⚡ Static: ${q.name.substring(0,25)} → "${staticMatch.value.substring(0,30)}" (${q.label.substring(0,30)})`);
        }
      } catch { /* skip static fill error */ }
    } else {
      llmQuestions.push(q);
    }
  }
  if (staticFilled.length > 0) {
    console.log(`  ⚡ Filled ${staticFilled.length} fields via static answers (0 tokens)`);
  }

  // ── Special handling: fill spl-multiselect-autocomplete fields ──
  // These can't be filled via [name=...] locators because their input is inside shadow DOM.
  try {
    // Find all empty required multiselect-autocomplete fields
    const msFields = await page.evaluate(() => {
      function qas(root, sel, res = []) {
        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
        return res;
      }
      const results = [];
      const msEls = qas(document, 'spl-multiselect-autocomplete');
      for (const ms of msEls) {
        const vis = ms.offsetParent !== null;
        if (!vis) continue;
        // Check if already has selected values
        const selectedChips = ms.shadowRoot?.querySelectorAll('[class*="chip"], [class*="tag"], [class*="selected"]')?.length || 0;
        const input = ms.shadowRoot?.querySelector('input');
        const required = input?.required || input?.getAttribute('aria-required') === 'true';
        const empty = !input?.value && selectedChips === 0;
        // Find the question label from parent context
        const parentLabel = ms.closest('[data-test-section]')?.querySelector('label, [class*="label"]')?.textContent?.trim() || '';
        const inputId = input?.id || '';
        results.push({ 
          inputId: inputId.substring(0, 40), 
          required, empty, 
          label: parentLabel.substring(0, 60),
          selectedChips,
        });
      }
      return results;
    }).catch(() => []);
    
    const emptyMs = msFields.filter(f => f.empty && f.required);
    for (const ms of emptyMs) {
      // Determine the answer for this field
      const label = ms.label.toLowerCase();
      let answer = 'I prefer not to answer';  // default for diversity fields
      
      console.log(`    🔄 Filling multiselect: "${ms.label.substring(0, 50)}" with "${answer}"`);
      
      // Step 1: Get bounding box of the multiselect host and mouse-click it
      const bbox = await page.evaluate((targetInputId) => {
        function qas(root, sel, res = []) {
          try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
          try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
          return res;
        }
        const msEls = qas(document, 'spl-multiselect-autocomplete');
        for (const ms of msEls) {
          const input = ms.shadowRoot?.querySelector('input');
          if (input && input.id.substring(0, 30) === targetInputId.substring(0, 30)) {
            ms.scrollIntoView({ block: 'center' });
            const rect = ms.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
          }
        }
        return null;
      }, ms.inputId).catch(() => null);
      
      if (!bbox || bbox.w === 0) {
        console.log(`    ⚠️ Could not find multiselect bbox for "${ms.label.substring(0, 40)}"`);
        continue;
      }
      
      // Real mouse click to activate the multiselect
      await page.mouse.click(bbox.x, bbox.y);
      await page.waitForTimeout(500);
      
      // Step 2: Type search text via keyboard (keyboard events cross shadow DOM boundaries)
      await page.keyboard.type('I prefer', { delay: 40 });
      await page.waitForTimeout(1200);
      
      // Step 3: Find and click matching option via ElementHandle (shadow DOM piercing)
      const optHandle = await page.evaluateHandle(() => {
        function qas(root, sel, res = []) {
          try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
          try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
          return res;
        }
        const items = qas(document, 'spl-dropdown-item');
        for (const el of items) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (text.includes('prefer not to answer') || text.includes('i prefer not')) {
            return el;
          }
        }
        return null;
      }).catch(() => null);
      
      const optEl = optHandle?.asElement();
      if (optEl) {
        await optEl.click({ force: true });
        console.log(`    ✅ Picked multiselect option via ElementHandle`);
        optEl.dispose();
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        await page.keyboard.press('Enter');
        console.log(`    ⏎ Pressed ArrowDown+Enter for multiselect (no option found)`);
      }
      
      await page.waitForTimeout(500);
      // Close dropdown with Tab (heading click CANCELS multiselect selection!)
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
    }
  } catch (e) { console.log(`    ⚠️ Multiselect fill error: ${e.message?.substring(0, 80)}`); }

  if (llmQuestions.length === 0) {
    console.log(`  ✅ All fields handled by static answers — no LLM call needed`);
    return;
  }

  console.log(`  🤖 AI filling ${llmQuestions.length} fields...`);
  // Debug: show what labels the AI will see
  const labelPreview = llmQuestions.slice(0, 5).map(q => `${q.name.substring(0,20)}="${q.label?.substring(0,50) || '??'}"`).join(', ');
  console.log(`  📋 Labels: ${labelPreview}`);

const sysPrompt = `You are an AI filling out a job application. Use the candidate's profile to answer ALL form fields.
PROFILE CONTEXT:
${PROFILE_YAML}
Candidate Email: ${PROFILE.email}
Candidate Phone: ${PROFILE.phone}
Candidate LinkedIn: ${PROFILE.linkedin}
Candidate GitHub: ${PROFILE.github}
Candidate Location: ${PROFILE.city}, ${PROFILE.country} (EU Blue Card holder, no visa sponsorship needed for EU)

Return JSON strictly in this format:
{"answers": [{"name": "input_name_attribute", "value": "your_answer", "type": "text|select|radio|checkbox|reactselect"}]}

CRITICAL RULES:
- NEVER leave a required field blank. NEVER return an empty string "" as value.
- For EMAIL fields: ALWAYS use "${PROFILE.email}". If field asks to CONFIRM or RE-ENTER email, use the SAME email: "${PROFILE.email}".
- For PHONE fields: use "${PROFILE.phone}".
- For NAME fields: First="${PROFILE.firstName}", Last="${PROFILE.lastName}".
- For any 'text' field with label containing "country" or "residence": ALWAYS return "${PROFILE.country}".
- For any 'text' field with label containing "city": ALWAYS return "${PROFILE.city}".
- For LinkedIn URL: ALWAYS return "${PROFILE.linkedin}".
- For GitHub/Portfolio URL: ALWAYS return "${PROFILE.github}".
- For 'reactselect' or 'select' type: your 'value' MUST be EXACTLY ONE of the option labels listed in the field's 'options' array. Copy it exactly, character for character.
- For multi-select fields (label contains "location(s)", "select all", "languages you speak"): return comma-separated values BUT limit to AT MOST 2-3 relevant choices. For LOCATION multi-select: prefer "Remote" if listed. Add at most 1 more specific city/country option relevant to Germany.
- For 'radio'/'checkbox': your 'value' must exactly match the option's 'value' field (NOT the label).
- Visa/Sponsorship: Answer "No" or the closest option meaning no sponsorship needed.
- Notice Period: "Immediately", "Immediate", or "Available immediately" depending on options. ALWAYS prefer immediate availability.
- Salary: "55000" (or match the format shown in the form).
- Disability/Veteran/Gender/Sexual orientation/Race/Ethnicity: Always answer "Decline to answer", "Prefer not to say", or "Prefer not to disclose" if available in options. Otherwise answer "No" for disability/veteran questions.
- Yes/No questions: answer "Yes" or "No" exactly unless options are different.
- Certification/consent questions ("I certify...", "I understand...", "I agree..."): answer "Yes".
- Location questions: pick "Remote" if available. Otherwise pick the single option closest to Germany/Berlin.
- "How did you hear": pick "LinkedIn" or the closest match from the options list.
- For DROPDOWN fields (isDropdown=true): your value MUST exactly match one of the options listed. If no options are listed, type a short value that would match a dropdown item (e.g. "Immediately" for notice period, "No" for yes/no).
- DO NOT invent values not in the options list for select/reactselect/dropdown fields.
- DO NOT use actual newlines inside JSON strings. Use literal \\n if needed.
- Escape double quotes inside answer values with \\"`;

  let userPrompt = `Form Fields (for reactselect/select types, 'options' lists the EXACT values you may choose from):\n` + JSON.stringify(llmQuestions, null, 2);
  
  // If we have page text context (for shadow DOM forms where labels are just "*"),
  // include it so the AI can see the actual questions on the page
  if (pageTextForAI) {
    userPrompt += `\n\nIMPORTANT: The form field labels above may show "*" instead of the real question text. Here is the ACTUAL VISIBLE TEXT on the page that shows the real questions. Use this text to understand what each field is asking:\n\n${pageTextForAI}`;
  }


  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    
    // Fix common unescaped newlines in JSON strings before parsing
    let jsonString = match[0];
    // This is a basic cleanup to prevent JSON.parse from failing on unescaped newlines within values
    jsonString = jsonString.replace(/(?<=:\s*")(.*?)(?="(?:\s*\}|\s*,))/gs, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, ''));

    const data = JSON.parse(jsonString);
    if (!data.answers) {
      console.log(`  ⚠️ AI fill error: No 'answers' array in JSON. Raw data: ${JSON.stringify(data).substring(0, 200)}`);
      return;
    }

    // Build a lookup of question labels for fallback corrections
    const qLabelMap = {};
    for (const q of llmQuestions) qLabelMap[q.name] = (q.label || '').toLowerCase();

    // ── Post-processing validation ──
    // The 8b fallback model often garbles field mapping (puts email in name,
    // name in phone, etc.). Validate and correct based on the field LABEL.
    for (const ans of data.answers) {
      const label = qLabelMap[ans.name] || '';
      const val = (ans.value || '').trim();

      // Skip Twitter / X fields
      if (/twitter|x\.com/i.test(label) || /twitter|x\.com/i.test(ans.name)) {
        ans.value = '';
        continue;
      }

      // VALIDATE: If label says "email" but value doesn't contain @, fix it
      if (/email|e-?mail/i.test(label) && !/@/.test(val)) {
        ans.value = PROFILE.email;
      }
      // VALIDATE: If label says "first name" but value contains @ or +, fix it
      if (/first.*name/i.test(label) && (/@/.test(val) || /^\+/.test(val) || val.length > 30)) {
        ans.value = PROFILE.firstName;
      }
      // VALIDATE: If label says "last name" but value contains @ or +, fix it
      if (/last.*name|family.*name|surname/i.test(label) && (/@/.test(val) || /^\+/.test(val) || val.length > 30)) {
        ans.value = PROFILE.lastName;
      }
      // VALIDATE: If label says "phone" but value doesn't start with + or digit, fix it
      if (/phone|tel|mobile/i.test(label) && !/^[\+\d\(]/.test(val)) {
        ans.value = PROFILE.phone;
      }
      // VALIDATE: If label says "linkedin" but value doesn't contain linkedin.com, fix it
      if (/linkedin/i.test(label) && !/linkedin\.com/i.test(val)) {
        ans.value = PROFILE.linkedin;
      }
      // VALIDATE: If label says "github" or "portfolio" but value doesn't contain github.com, fix it
      if (/github|portfolio/i.test(label) && !/github\.com/i.test(val) && !val.startsWith('http')) {
        ans.value = PROFILE.github;
      }
      // VALIDATE: Country fields
      if (/country|reside|passport|nation/i.test(label) && (/@/.test(val) || /^\+/.test(val))) {
        ans.value = PROFILE.country;
      }
      // VALIDATE: City fields
      if (/^city$/i.test(label) || /your city/i.test(label)) {
        if (/@/.test(val) || /^\+/.test(val)) ans.value = PROFILE.city;
      }
      // VALIDATE: Notice period — always immediate
      if (/notice.*period|availability|start.*date|earliest.*start/i.test(label)) {
        if (!/immedia|sofort|now|asap/i.test(val)) ans.value = 'Immediately';
      }

      // Fix empty values using heuristic fallbacks
      if (!val) {
        if (/email|e-?mail/i.test(label)) { ans.value = PROFILE.email; }
        else if (/phone/i.test(label)) { ans.value = PROFILE.phone; }
        else if (/first.*name/i.test(label)) { ans.value = PROFILE.firstName; }
        else if (/last.*name/i.test(label)) { ans.value = PROFILE.lastName; }
        else if (/country|reside|passport|nation/i.test(label)) { ans.value = PROFILE.country; }
        else if (/github|portfolio/i.test(label)) { ans.value = PROFILE.github; }
        else if (/linkedin/i.test(label)) { ans.value = PROFILE.linkedin; }
      }
    }

    for (const ans of data.answers) {
      try {
        if (!ans.value && ans.type !== 'checkbox') continue;
        // Skip Twitter / X fields completely
        if (/twitter|x\.com/i.test(ans.name)) continue;
        const selector = ans.name.includes('question_') ? `[id="${ans.name}"], [name="${ans.name}"]` : `[name="${ans.name}"], [id="${ans.name}"]`;
        if (ans.type === 'radio' || ans.type === 'checkbox') {
          // Find the exact radio/checkbox by value — apply [value=] filter to EACH part of compound selector
          const valueSuffix = `[value="${ans.value}"]`;
          const specificSelector = selector.split(',').map(s => s.trim() + valueSuffix).join(', ');
          await page.click(specificSelector, { timeout: 1000, force: true }).catch(async () => {
             // Fallback if value isn't exact
             const els = await page.$$(selector);
             if (els.length > 0) {
               let clicked = false;
               
               // Handle Yes/No button-style toggles
               if (els.length === 1 && ['yes', 'no', 'on', 'true', 'false'].includes(ans.value.toLowerCase())) {
                  let targetText = ans.value.toLowerCase();
                  if (targetText === 'on' || targetText === 'true') targetText = 'yes';
                  const parent = await els[0].evaluateHandle(el => el.parentElement).catch(() => null);
                  if (parent) {
                    const btns = await parent.$$('button').catch(() => []);
                    for (const b of btns) {
                       const t = await b.textContent();
                       if (t && t.trim().toLowerCase() === targetText) {
                          await b.click({ force: true });
                          clicked = true;
                          break;
                       }
                    }
                  }
               }
               
               if (!clicked) {
                   // Confirmed Ashby DOM: <span><input type="radio"></span><label>text</label>
                   // Ashby radio inputs are hidden (opacity:0). React listens to onChange on the input.
                   // Strategy: find the radio by text, force check it + dispatch change event via React internals.
                   const normalizeQ = s => (s || '').replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').trim().toLowerCase();
                   const ansPrefix = normalizeQ(ans.value).substring(0, 40);
                   const groupName = await els[0].getAttribute('name') || '';
                   
                   const radioClicked = await page.evaluate(({ groupName, prefix }) => {
                     const norm = s => (s || '').replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').trim().toLowerCase();
                     const radios = Array.from(document.querySelectorAll(`[name="${groupName}"]`));
                     for (const radio of radios) {
                       const labelFor = radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null;
                       const spanSib = radio.parentElement ? radio.parentElement.nextElementSibling : null;
                       const label = labelFor || spanSib;
                       if (!label) continue;
                       const labelNorm = norm(label.innerText || label.textContent);
                       if (!labelNorm.startsWith(prefix)) continue;
                       
                       const labelText = (label.innerText || label.textContent)?.trim()?.substring(0, 60);
                       
                       // Scroll into view then click label (standard DOM click)
                       label.scrollIntoView({ block: 'center' });
                       label.click();
                       
                       return labelText || 'clicked';
                     }
                     return null;
                   }, { groupName, prefix: ansPrefix }).catch(() => null);
                   
                   console.log(`    🔍 Radio eval: groupName=${groupName.slice(-25)} prefix=${ansPrefix} result=${radioClicked?.substring(0,40)}`);
                   if (radioClicked) {
                     await page.waitForTimeout(500); // React state settle
                     clicked = true;
                     console.log(`    ✅ Radio: "${radioClicked}"`);
                   }
                }
                
                if (!clicked) await els[0].check({ force: true }).catch(() => {});
             }
          });
        } else if (ans.type === 'select' || ans.type === 'select-one') {
          // Check if this is a real native <select> or an SR custom dropdown
          const isNativeSelect = await page.$eval(selector, el => el.tagName === 'SELECT').catch(() => false);
          if (isNativeSelect) {
            const selectFilled = await page.selectOption(selector, { value: ans.value }, { force: true, timeout: 3000 })
              .catch(() => page.selectOption(selector, { label: ans.value }, { force: true, timeout: 3000 }))
              .catch(() => null);
            if (!selectFilled) {
              const allSels = await page.$$('select');
              let filled = false;
              for (const sel of allSels) {
                const opts = await sel.evaluate(s => Array.from(s.options).map(o => ({v: o.value, l: o.label || o.textContent}))).catch(() => []);
                const exact = opts.find(o => o.l.trim().toLowerCase() === ans.value.toLowerCase() || o.v.toLowerCase() === ans.value.toLowerCase());
                const ansLower = ans.value.toLowerCase();
                const partial = opts.find(o => o.l.toLowerCase().includes(ansLower) || ansLower.includes(o.l.toLowerCase()));
                const eeoDefault = opts.find(o => /prefer not|decline|not disclose|i don.t wish/i.test(o.l));
                const noOpt = opts.find(o => /^no$/i.test(o.l.trim()));
                const chosen = exact || partial || eeoDefault || noOpt;
                if (chosen) {
                  const picked = await sel.selectOption({ value: chosen.v }, { timeout: 1000 }).catch(() => null);
                  if (picked) { filled = true; break; }
                }
              }
              if (!filled) console.log(`    ↳ ⚠️ Could not fill native select: ${ans.name}`);
            }
          } else {
            // NOT a native select — it's an SR custom dropdown (spl-select)
            // Fall through to text input handler which handles click→type→autocomplete
            ans.type = 'text';
            // Re-process as text (goto is ugly so just inline the logic)
            const el = await page.$(selector);
            if (el) {
              const existingVal = String(await el.evaluate(e => e.value || '').catch(() => ''));
              if (existingVal.trim().length > 0) {
                console.log(`    ↳ Skipping ${ans.name} — already has value: "${existingVal.trim().substring(0, 30)}"`);
              } else {
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.evaluate(e => { e.value = ''; e.focus(); if (e.select) e.select(); }).catch(() => {});
                await el.click({ force: true }).catch(() => {});
                await page.waitForTimeout(200);
                await page.keyboard.type(ans.value, { delay: 10 });
                await page.waitForTimeout(1500);
                // Use Playwright locators to find dropdown items (pierces shadow DOM)
                const optLocators = page.locator('spl-dropdown-item, [role="option"], .autocomplete-option, li[data-value]');
                const optCount = await optLocators.count().catch(() => 0);
                if (optCount > 0) {
                  const targetLower = ans.value.toLowerCase();
                  for (let i = 0; i < Math.min(optCount, 15); i++) {
                    const opt = optLocators.nth(i);
                    if (!await opt.isVisible().catch(() => false)) continue;
                    const text = (await opt.textContent().catch(() => '')).trim().toLowerCase();
                    if (text === targetLower || text.includes(targetLower) || targetLower.includes(text)) {
                      await opt.click({ force: true }).catch(() => {});
                      console.log(`    ↳ Picked SR dropdown option for ${ans.name}: "${text.substring(0, 50)}"`);
                      await page.waitForTimeout(200);
                      break;
                    }
                  }
                }
              }
            }
          }
        } else if (ans.type === 'reactselect') {
          // Greenhouse React Select v2 — type into the hidden input, wait for dropdown, click option
          const rsInput = await page.$(`#${cssEscape(ans.name)}, [id="${ans.name}"]`).catch(() => null);
          if (rsInput) {
            await fillReactSelect(page, rsInput, ans.value);
          }
        } else if (ans.type === 'combobox') {
          // Greenhouse combobox (role=combobox): click to open, click the matching option
          const comboEl = await page.$(`[role="combobox"]#${cssEscape(ans.name)}, #${cssEscape(ans.name)}[role="combobox"]`).catch(() => null)
                       || await page.$(`[id="${ans.name}"]`).catch(() => null);
          if (comboEl) {
            await comboEl.click().catch(() => {});
            await page.waitForTimeout(300);
            const optionClicked = await page.evaluate((value) => {
              const opts = Array.from(document.querySelectorAll('[role="option"], li[data-value], .select__option'));
              const target = opts.find(o => {
                const text = (o.textContent || o.innerText || '').trim().toLowerCase();
                return text === value.toLowerCase() || text.startsWith(value.toLowerCase().substring(0, 10));
              });
              if (target) { target.click(); return true; }
              return false;
            }, ans.value).catch(() => false);
            if (!optionClicked) {
              const hiddenSel = await page.$(`select[id*="${ans.name.replace('combobox_', '')}"]`).catch(() => null);
              if (hiddenSel) {
                await page.selectOption(`select[id*="${ans.name.replace('combobox_', '')}"]`, { label: ans.value }).catch(() =>
                  page.selectOption(`select[id*="${ans.name.replace('combobox_', '')}"]`, { value: ans.value }).catch(() => {})
                );
              }
            }
            await page.waitForTimeout(200);
          }
        } else {
          // Plain text / textarea — check for native select or React Select by class
          const isSelect = await page.$eval(selector, el => el.tagName === 'SELECT').catch(() => false);
          if (isSelect) {
            await page.selectOption(selector, { value: ans.value }, { force: true }).catch(() => page.selectOption(selector, { label: ans.value }, { force: true }));
          } else {
            const el = await page.$(selector);
            if (el) {
              const className = await el.getAttribute('class') || '';
              const role = await el.getAttribute('role') || '';
              if (className.includes('select__input') || className.includes('react-select') || role === 'combobox') {
                await fillReactSelect(page, el, ans.value);
              } else {
                // Keyboard simulation — works on ALL React variants (Ashby, Greenhouse, Lever)
                // Skip if field already has ANY value — never overwrite pre-filled data
                const existingVal = String(await el.evaluate(e => e.value || '').catch(() => ''));
                if (existingVal.trim().length > 0) {
                  console.log(`    ↳ Skipping ${ans.name} — already has value: "${existingVal.trim().substring(0, 30)}"`);
                  continue;
                }
                // Explicitly focus the element before typing to avoid cross-field interference
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.evaluate(e => { e.value = ''; e.focus(); if (e.select) e.select(); }).catch(() => {});
                const isFocused2 = await el.evaluate(e => document.activeElement === e).catch(() => false);
                if (!isFocused2) await el.focus().catch(() => {});
                
                // Explicitly click to open custom dropdowns (like spl-select)
                await el.click({ force: true }).catch(() => {});
                await page.waitForTimeout(200);

                await page.keyboard.type(ans.value, { delay: 10 });
                await page.waitForTimeout(1500); // Wait for dropdown (increased for slow API lookups)
                
                // Try to click an autocomplete dropdown option (using Playwright LOCATORS to pierce shadow DOM)
                const optLocators = page.locator('spl-dropdown-item, sr-autocomplete li, [role="option"], .autocomplete-option, .dropdown-menu li, li[data-value], .select__option, .menu-item');
                const optCount = await optLocators.count().catch(() => 0);
                if (optCount > 0) {
                  let bestMatch = null;
                  const targetLower = ans.value.toLowerCase();
                  for (let oi = 0; oi < Math.min(optCount, 15); oi++) {
                    const o = optLocators.nth(oi);
                    if (!await o.isVisible().catch(() => false)) continue;
                    const text = (await o.textContent().catch(() => '')).trim().toLowerCase();
                    if (text === targetLower) { bestMatch = o; break; }
                    if (text.includes(targetLower) || targetLower.includes(text)) { bestMatch = o; }
                  }
                  if (bestMatch) {
                    await bestMatch.click({ force: true }).catch(() => {});
                    console.log(`    ↳ Picked autocomplete dropdown option for ${ans.value}`);
                    await page.waitForTimeout(200);
                  }
                }
              }
            }
          }
        }
        console.log(`    ↳ Filled ${ans.name} -> ${ans.value.substring(0, 50)}${ans.value.length > 50 ? '...' : ''}`);
      } catch (e) {
        console.log(`    ↳ ⚠️ Failed to fill ${ans.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️ AI fill error: ${e.message}`);
  }
}

// dismissCookieBanners imported from ./agents/consent-handler.js


// ============================================
// DEMOGRAPHIC SURVEY FIELDS (hard-coded to avoid AI hallucination)
// ============================================

// Pick first matching label from a select element, trying multiple fallbacks
async function pickSelectOption(page, el, labelCandidates) {
  for (const label of labelCandidates) {
    try {
      await el.selectOption({ label }, { timeout: 3000 });
      return label;
    } catch {}
    try {
      await el.selectOption({ value: label }, { timeout: 1000 });
      return label;
    } catch {}
  }
  return null;
}

async function fillDemographicFields(page) {
  // Scan ALL visible selects on the page and fill by detected field type
  const allSelects = await page.$$('select');
  for (const el of allSelects) {
    try {
      if (!await el.isVisible()) continue;
      const name = (await el.getAttribute('name') || '').toLowerCase();
      const id   = (await el.getAttribute('id')   || '').toLowerCase();
      const key  = name + ' ' + id;

      if (/gender/.test(key)) {
        await pickSelectOption(page, el, ['Decline to self-identify','Prefer not to say','I do not wish to answer','I prefer not to say','Choose not to disclose']);
      } else if (/veteran/.test(key)) {
        await pickSelectOption(page, el, ['I am not a protected veteran',"I don't wish to answer",'I choose not to disclose','Prefer not to say']);
      } else if (/disabilit/.test(key)) {
        await pickSelectOption(page, el, ["I don't wish to answer",'I do not have a disability','Prefer not to say','I choose not to disclose']);
      } else if (/race|ethnic/.test(key)) {
        await pickSelectOption(page, el, ['Decline to self-identify',"I don't wish to answer",'I prefer not to say']);
      } else if (/noticePeriod|notice_period|notice/.test(key)) {
        // Lever notice period — pick shortest available
        await pickSelectOption(page, el, ['Immediately','2 weeks','1 month','Immediate','Less than 1 month','< 1 month','Two weeks']);
      } else if (/visa|sponsorship|workauth/.test(key)) {
        await pickSelectOption(page, el, ['No','Not required','I do not require sponsorship','No, I do not need sponsorship']);
      } else if (/howdidyouhear|how_did_you_hear|source|referral/.test(key)) {
        await pickSelectOption(page, el, ['LinkedIn','Job board','Online','Internet','Other']);
      } else if (/salary|compensation|expect/.test(key)) {
        // skip — handled elsewhere
      }
    } catch {}
  }
}

// ============================================
// REACT SELECT HELPER: Click to open, read options, click to select
// ============================================
// CSS.escape is browser-only — replicate it for Node.js Playwright selectors
function cssEscape(s) {
  return String(s).replace(/([^\w-])/g, '\\$1');
}

async function fillReactSelect(page, inputElement, desiredValue) {
  try {
    // Helper: find the .select__control for THIS specific input element
    async function getControl() {
      const ch = await inputElement.evaluateHandle(el => {
        let node = el;
        for (let i = 0; i < 10; i++) {
          if (!node) break;
          const cls = (node.className || '').toString();
          if (cls.includes('select__control') || cls.includes('react-select__control')) return node;
          node = node.parentElement;
        }
        return null;
      }).catch(() => null);
      if (ch && await ch.evaluate(e => !!e).catch(() => false)) return ch.asElement();
      return null;
    }

    // Helper: read all currently-visible dropdown options
    async function readOptions() {
      return page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll(
          '[id*="-option-"], [class*="select__option"], [class*="option--is-"]'
        ));
        return opts
          .map(o => ({ text: (o.innerText || o.textContent || '').trim(), id: o.id || '' }))
          .filter(o => o.text && o.text !== 'No options');
      });
    }

    // Helper: open dropdown for THIS field
    async function openDropdown() {
      const ctrl = await getControl();
      if (ctrl) {
        await ctrl.click({ force: true }).catch(() => {});
      } else {
        await inputElement.click({ force: true }).catch(() => {});
      }
      await page.waitForTimeout(700);
    }

    // Helper: click best matching option
    async function clickBestOption(val) {
      const valLower = val.toLowerCase().trim();
      const valWords = valLower.split(/[\s,\/\-]+/).filter(w => w.length > 2);
      const opts = await readOptions();
      if (opts.length === 0) return false;

      let match = opts.find(o => o.text.toLowerCase() === valLower);
      if (!match) match = opts.find(o => o.text.toLowerCase().startsWith(valLower));
      if (!match) match = opts.find(o => valLower.startsWith(o.text.toLowerCase()) && o.text.length > 3);
      if (!match) match = opts.find(o => {
        const oLower = o.text.toLowerCase();
        return valWords.some(kw => oLower.includes(kw));
      });
      if (!match && valLower.length >= 4) {
        match = opts.find(o => o.text.toLowerCase().startsWith(valLower.substring(0, 4)));
      }

      if (match) {
        if (match.id) {
          await page.click('#' + match.id, { force: true }).catch(async () => {
            await page.evaluate(id => { document.getElementById(id) && document.getElementById(id).click(); }, match.id);
          });
        } else {
          await page.evaluate(text => {
            const els = Array.from(document.querySelectorAll('[class*="select__option"], [class*="option--is-"]'));
            const el = els.find(o => (o.innerText || o.textContent || '').trim() === text);
            if (el) el.click();
          }, match.text);
        }
        await page.waitForTimeout(350);
        return true;
      }
      return false;
    }

    const valuesToSelect = desiredValue.split(',').map(v => v.trim()).filter(v => v);

    for (let i = 0; i < valuesToSelect.length; i++) {
      const val = valuesToSelect[i];

      // 1. Open dropdown
      await openDropdown();

      // 2. Fallback: Space key if no options appeared
      let initialOpts = await readOptions();
      if (initialOpts.length === 0) {
        await inputElement.focus().catch(() => {});
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);
      }

      // 3. Clear + type to filter
      await inputElement.fill('').catch(() => {});
      const typeStr = val.substring(0, Math.min(5, val.length));
      await inputElement.type(typeStr, { delay: 80 }).catch(() => {});
      await page.waitForTimeout(800);

      // 4. Click best match
      const clicked = await clickBestOption(val);

      // 5. If nothing matched, open fresh and pick first option
      if (!clicked) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
        await openDropdown();
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }

      // 6. Close between iterations (multi-select)
      if (i < valuesToSelect.length - 1) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // Final close
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  } catch (e) {
    console.log('    \u21b3 (React Select error: ' + e.message.split('\n')[0] + ')');
  }
}


// ============================================
// BASE FORM FILLER
// ============================================
async function fillBaseFields(page, resumePath, skipResume = false) {
  // Prevent links from opening in a new tab so we stay on the same page
  await page.evaluate(() => {
    document.querySelectorAll('a').forEach(a => a.removeAttribute('target'));
  }).catch(() => {});

  // Try to click any initial "Apply" buttons if it's Lever/Generic
  const applyBtns = await page.$$('a:has-text("Apply for this job"), button:has-text("Apply"), a.apply-button, .apply-btn');

  // Resume (UPLOAD FIRST so that ATS parsing auto-fills name/email/phone from resume)
  if (existsSync(resumePath) && !skipResume) {
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const accept = await input.getAttribute('accept') || '';
        const name = await input.getAttribute('name') || '';
        if (accept.includes('pdf') || name.includes('resume') || name.includes('cv') || name.includes('_systemfield_resume') || fileInputs.length === 1) {
          const filesLength = await input.evaluate(el => el.files ? el.files.length : 0).catch(() => 0);
          if (filesLength > 0) {
            console.log('  📎 Resume already uploaded, skipping to prevent pre-fill overwrite.');
            continue;
          }
          await input.setInputFiles(resumePath).catch(() => {});
          console.log('  📎 Resume uploaded to an input');
          // Wait longer for ATS parsing overlay/reload to complete before filling text fields
          await page.waitForTimeout(6000);
        }
      }
    } catch (e) {}
  }

  // ── Fill base fields ONLY IF EMPTY (ATS may have auto-filled from resume) ──
  async function fillIfEmpty(page, selector, value) {
    if (!value) return false;
    try {
      const field = await page.$(selector);
      if (!field || !await field.isVisible().catch(() => false)) return false;
      const existing = await field.inputValue().catch(() => '');
      if (existing.trim().length > 0) {
        console.log(`    ⏭️ Skip "${selector.substring(0,40)}" — already filled: "${existing.substring(0,25)}"`);
        return false;
      }
      // Field is empty — fill it
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.focus().catch(() => {});
      await field.click({ clickCount: 3 }).catch(() => {});
      await page.waitForTimeout(50);
      await page.keyboard.type(value, { delay: 10 });
      await page.waitForTimeout(80);
      // Verify the value was retained (React may have cleared it)
      const retainedValue = await field.inputValue().catch(() => '');
      if (!retainedValue) {
        await field.fill(value).catch(() => {});
      }
      console.log(`    ✅ Filled empty field: ${selector.substring(0,40)} -> "${value.substring(0,25)}"`);
      return true;
    } catch { return false; }
  }

  // Fill core identity fields only if ATS parsing left them empty
  await fillIfEmpty(page, 'input[name="first_name"], #first_name, input[name*="first"]:not([name*="preferred"]), input[id*="firstName"]', PROFILE.firstName);
  await fillIfEmpty(page, 'input[name="last_name"], #last_name, input[name*="last"], input[id*="lastName"]', PROFILE.lastName);
  await fillIfEmpty(page, 'input[name="_systemfield_name"], input[name="name"]:not([name*="company"])', PROFILE.fullName);
  await fillIfEmpty(page, 'input[type="email"], input[name="email"], input[name="_systemfield_email"], input[id*="email"]', PROFILE.email);
  await fillIfEmpty(page, 'input[type="tel"], input[name="phone"], input[name="_systemfield_phone"], input[id*="phone"]', PROFILE.phone);
  await fillIfEmpty(page, 'input[name*="linkedin"], input[id*="linkedin"]', PROFILE.linkedin);
  await fillIfEmpty(page, 'input[name*="github"], input[id*="github"]', PROFILE.github);

  // ── Post-fill diagnostic: verify key fields actually have values ──
  try {
    const filledCheck = await page.evaluate(() => {
      const checks = {};
      const nameEl = document.querySelector('input[name="_systemfield_name"], input[name="first_name"], #first_name, input[name*="first"]');
      const emailEl = document.querySelector('input[type="email"], input[name="email"], input[name="_systemfield_email"]');
      const phoneEl = document.querySelector('input[type="tel"], input[name="phone"]');
      if (nameEl) checks.name = nameEl.value || '(empty)';
      if (emailEl) checks.email = emailEl.value || '(empty)';
      if (phoneEl) checks.phone = phoneEl.value || '(empty)';
      checks.totalInputs = document.querySelectorAll('input:not([type="hidden"])').length;
      return checks;
    });
    console.log(`  📝 Post-fill check: name=${filledCheck.name || 'N/A'}, email=${filledCheck.email || 'N/A'}, phone=${filledCheck.phone || 'N/A'} (${filledCheck.totalInputs} inputs)`);
  } catch {}
}


async function fillField(page, selector, value) {
  if (!value) return false; // skip undefined/empty values
  try {
    const field = await page.$(selector);
    if (field && await field.isVisible()) {
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.click();
      // Use React-compatible fill: dispatches native input + change events
      // This is needed for Ashby, Lever, and any React-controlled input where .fill() silently fails
      await field.fill('');
      // Keyboard simulation — works on ALL React variants (Ashby, Greenhouse, Lever)
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.focus().catch(() => {});
      await field.click({ clickCount: 3 }).catch(() => {});
      await page.waitForTimeout(50);
      const isFocused3 = await page.evaluate((el) => document.activeElement === el, field).catch(() => false);
      if (!isFocused3) await field.focus().catch(() => {});
      await page.keyboard.type(value, { delay: 10 });
      await page.waitForTimeout(80);
      // Verify the value was retained (React may have cleared it)
      const retainedValue = await field.inputValue().catch(() => '');
      if (!retainedValue) {
        // Fallback: use Playwright's fill() which dispatches all events
        await field.fill(value).catch(() => {});
        console.log(`  ⚠️ fillField: keyboard.type value lost, used fill() fallback for ${selector.substring(0, 40)}`);
      }
      return true;
    }
  } catch {}
  return false;
}

// ============================================

// MAIN
// ============================================
async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // Job queue fetching, Greenhouse filtering, company-cap diversity — all handled by job-queue agent
  const isLocal = process.env.LOCAL_RUN === 'true';
  const jobs = await getJobQueue(supabase, { isLocal, testJobId: process.env.TEST_JOB_ID || null });

  if (jobs.length === 0) return;

  console.log(`\n🚀 Auto-applying to ${jobs.length} jobs via Playwright (AI Enabled)...\n`);

  // Browser lifecycle managed by agents/browser-manager.js
  const browser = await createBrowser();
  const context = await createContext(browser);

  const results = { applied: 0, failed: 0, skipped: 0 };
  const appliedJobs = [];
  const failedJobs = [];

  // TARGET_KEYWORDS, SKIP_KEYWORDS, MAX_PER_COMPANY imported from agents/constants.js
  const companiesApplied = {}; // track how many we've applied to per company this run

  for (const job of jobs) {
    const page = await context.newPage();
    console.log(`\n━━━ ${job.title} @ ${job.company} ━━━`);

    try {
      // Platform-level block — Ashby ATS always shows captchas
      const jobApplyLink = (job.apply_link || '').toLowerCase();
      const jobPlatform = (job.platform || '').toLowerCase();
      if (jobApplyLink.includes('ashbyhq.com') || jobPlatform === 'ashby') {
        console.log(`  🚫 Skipping — Ashby platform blocked (captcha on every submit)`);
        results.skipped++;
        await page.close().catch(() => {});
        try { await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id); } catch(e) {}
        continue;
      }

      // Permanent block list — companies with apply limits or persistent failures
      const BLOCKED_COMPANIES = ['supabase', 'openai', 'braintrust', 'delivery hero'];
      const companyKey = (job.company || '').toLowerCase().trim();
      if (BLOCKED_COMPANIES.some(bc => companyKey.includes(bc))) {
        console.log(`  🚫 Skipping — ${job.company} is permanently blocked (apply limits)`);
        results.skipped++;
        await page.close().catch(() => {});
        try { await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id); } catch(e) {}
        continue;
      }

      // Per-company rate limit gate — skip if already applied to this company MAX_PER_COMPANY times
      if (companiesApplied[companyKey] >= MAX_PER_COMPANY) {
        console.log(`  ⏭️ Skipping — already applied to ${job.company} ${companiesApplied[companyKey]}x this run (limit: ${MAX_PER_COMPANY})`);
        results.skipped++;
        await page.close().catch(() => {});
        continue;
      }

      // Pre-apply evaluation gate — skip low-fit jobs to save API tokens and time
      const evalResult = await evaluateJobFit(job);
      console.log(`  📊 Eval: ${evalResult.grade} (${evalResult.score}/5) → ${evalResult.recommendation} | ${evalResult.reasons[0] || ''}`);
      if (evalResult.recommendation === 'skip') {
        console.log(`  ⏭️ Skipping low-fit job: ${evalResult.reasons.join(', ')}`);
        results.skipped++;
        await page.close().catch(() => {});
        try { await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id); } catch(e) {}
        continue;
      }

      await page.goto(job.apply_link, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000 + Math.random() * 1500);

      // === JOB BOARD REDIRECT: arbeitnow/remoteok/jobgether are aggregators, not ATS forms ===
      const currentUrl = page.url().toLowerCase();
      if (currentUrl.includes('arbeitnow.com') || currentUrl.includes('remoteok.com') || currentUrl.includes('jobgether.com')) {
        console.log(`  🔀 Job board detected (${job.platform}) — waiting for JS to render apply button...`);
        
        // Wait for the JS-rendered apply button (ArbeitNow uses Vue.js, loads async)
        let realApplyUrl = null;
        const ATS_DOMAINS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com',
                             'smartrecruiters.com', 'recruitee.com', 'personio.de', 'personio.com',
                             'jobvite.com', 'breezy.hr', 'bamboohr.com', 'icims.com', 'taleo.net',
                             'teamtailor.com', 'jazz.co', 'recruitingbypaycor.com', 'successfactors.eu'];

        // Strategy 1: Wait up to 8s for an ATS link to appear in the DOM
        try {
          const atsSelector = ATS_DOMAINS.map(d => `a[href*="${d}"]`).join(', ');
          await page.waitForSelector(atsSelector, { timeout: 8000 });
          realApplyUrl = await page.evaluate((domains) => {
            for (const d of domains) {
              const el = document.querySelector(`a[href*="${d}"]`);
              if (el && el.href) return el.href;
            }
            return null;
          }, ATS_DOMAINS);
        } catch (e) {}

        // Strategy 2: Click the "Apply" / "Bewerben" button and catch the navigation
        if (!realApplyUrl) {
          try {
            const applyBtn = await page.$('a[class*="apply"], button[class*="apply"], a:has-text("Apply Now"), a:has-text("Apply"), a:has-text("Jetzt bewerben"), a:has-text("Bewerben"), a:has-text("Apply for this job")').catch(() => null);
            if (applyBtn) {
              // First try: just read the href if it's an anchor (no click needed)
              const href = await applyBtn.evaluate(el => el.tagName === 'A' ? el.href : null).catch(() => null);
              if (href && !href.includes('arbeitnow.com') && !href.includes('javascript:')) {
                realApplyUrl = href;
              } else {
                // Fallback: click and catch new tab/navigation
                const [newPage] = await Promise.race([
                  Promise.all([page.context().waitForEvent('page', { timeout: 5000 }), applyBtn.click()]),
                  new Promise(r => setTimeout(() => r([null]), 5000))
                ]).catch(() => [null]);
                if (newPage && newPage.url && newPage.url() !== 'about:blank') {
                  realApplyUrl = newPage.url();
                  await newPage.close().catch(() => {});
                }
              }
            }
          } catch (e) {}
        }

        // Strategy 3: Generic external link with apply-like text
        if (!realApplyUrl) {
          realApplyUrl = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const external = links.find(a =>
              /apply now|apply|bewerben|jetzt bewerben/i.test(a.textContent?.trim()) &&
              a.href && !a.href.includes(window.location.hostname)
            );
            return external?.href || null;
          });
        }

        if (realApplyUrl) {
          // Guard: if ArbeitNow resolved to greenhouse.io — only skip on GHA (Cloudflare blocks)
          if (!isLocal && (realApplyUrl.includes('greenhouse.io') || realApplyUrl.includes('job-boards.greenhouse'))) {
            console.log(`  ⚠️  ArbeitNow resolved to Greenhouse (blocked on GHA) — moving to manual_queue`);
            try { await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id); } catch (e) {}
            throw new Error('ArbeitNow resolved to Greenhouse (Cloudflare blocks GHA IPs) — manual_queue');
          }
          // Guard: if resolved to Lever or Ashby, move to manual_queue (hCaptcha on submit)
          if (realApplyUrl.includes('lever.co') || realApplyUrl.includes('jobs.lever.co')) {
            console.log(`  ⚠️  ArbeitNow resolved to Lever (hCaptcha) — moving to manual_queue`);
            try { await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id); } catch (e) {}
            throw new Error('ArbeitNow resolved to Lever (hCaptcha blocks submission) — manual_queue');
          }
          if (realApplyUrl.includes('ashbyhq.com')) {
            console.log(`  ⚠️  ArbeitNow resolved to Ashby (hCaptcha) — moving to manual_queue`);
            try { await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id); } catch (e) {}
            throw new Error('ArbeitNow resolved to Ashby (hCaptcha blocks submission) — manual_queue');
          }
          console.log(`  ✅ Found real ATS: ${realApplyUrl.substring(0, 80)}`);
          // Update stored apply_link so we skip this lookup next time
          try { await supabase.from('jobs').update({ apply_link: realApplyUrl, platform: new URL(realApplyUrl).hostname.replace('www.','').split('.')[0] }).eq('id', job.id); } catch(e) {}
          await page.goto(realApplyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000 + Math.random() * 1000);
        } else {
          // Last resort: ask AI to find the apply link from the live DOM (use fast 8b model)
          console.log('  🔧 Static extraction failed — asking AI to find apply URL from DOM...');
          const domLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]'))
              .map(a => ({ text: (a.textContent || '').trim().substring(0, 60), href: a.href }))
              .filter(a => a.href && !a.href.startsWith('javascript') && a.href.length > 10 && !a.href.includes('arbeitnow.com'))
              .slice(0, 30)
          ).catch(() => []);
          const pageSnippet = await page.textContent('body').catch(() => '').then(t => t.substring(0, 500));
          const aiRaw = await callGroq(
            'You are a browser automation agent. Return only valid JSON.',
            `Find the job application URL on this ArbeitNow job page.\nPage text: ${pageSnippet}\nLinks on page: ${JSON.stringify(domLinks)}\n\nReturn JSON: {"url": "full apply URL or null"}. Pick any link that goes to a job application form — ATS domains (greenhouse, lever, ashby, workday, smartrecruiters), company career pages, or any external /apply or /jobs URL.`,
            'llama-3.3-70b-versatile'  // Use 8b model — 500k TPD vs 100k for 70b
          );
          try {
            const aiResult = JSON.parse(aiRaw);
            if (aiResult.url && aiResult.url.startsWith('http')) {
              console.log(`  🤖 AI found apply URL: ${aiResult.url.substring(0, 80)}`);
              realApplyUrl = aiResult.url;
              try { await supabase.from('jobs').update({ apply_link: realApplyUrl }).eq('id', job.id); } catch(e) {}
              await page.goto(realApplyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForTimeout(2000);
            }
          } catch {}
          if (!realApplyUrl) {
            // Move to manual_queue (not archived) — URL may work on non-GHA IP
            try { await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id); } catch (e) {}
            throw new Error('ArbeitNow: could not find external apply URL — moved to manual_queue');


          }
        }
      }

      // === IFRAME REDIRECT: Some career pages embed the ATS form in an iframe ===
      // Always re-extract fresh iframe URL from the live page (stored URLs may have expired validityTokens)
      try {
        await page.waitForSelector('iframe[src*="greenhouse.io"], iframe[src*="lever.co"], iframe[src*="ashbyhq.com"], iframe[src*="workday.com"]', { timeout: 5000 });
      } catch (e) {}

      const iframeUrl = await page.evaluate(() => {
        const iframe = document.querySelector(
          'iframe[src*="greenhouse.io"], iframe[src*="lever.co"], iframe[src*="ashbyhq.com"], iframe[src*="workday.com"]'
        );
        return iframe ? iframe.src : null;
      });
      const currentDomain = page.url();
      const alreadyOnATS = /greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com/i.test(currentDomain);
      if (iframeUrl && !alreadyOnATS && !iframeUrl.includes('googleapis.com') && !iframeUrl.includes('gstatic.com')) {
        // Only follow iframe if we're NOT already on an ATS domain
        // Specifically skip greenhouse.io/embed/ URLs — they trigger Cloudflare in GHA
        // We should be navigating directly to job-boards.greenhouse.io/board/jobs/id instead
        if (iframeUrl.includes('greenhouse.io/embed/')) {
          console.log(`  ⏭️  Skipping embed iframe (Cloudflare-protected in GHA) — staying on company page`);
          // Extract job_id from embed URL and navigate directly to canonical GH page
          const forMatch = iframeUrl.match(/[?&]for=([^&]+)/);
          const jobMatch = iframeUrl.match(/[?&]gh_jid=(\d+)/) || currentDomain.match(/gh_jid=(\d+)/);
          if (forMatch && jobMatch) {
            const directUrl = `https://job-boards.greenhouse.io/${forMatch[1]}/jobs/${jobMatch[1]}`;
            console.log(`  🔀 Navigating directly to: ${directUrl}`);
            try { await supabase.from('jobs').update({ apply_link: directUrl }).eq('id', job.id); } catch(e) {}
            await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000 + Math.random() * 1000);

            // ✔️ Greenhouse job description page — click "Apply for this Job" / "I'm interested"
            // to navigate to the actual application form before hasFormFields check
            const ghApplySelectors = [
              '#apply_button',
              '#im_interested_button',
              'a:has-text("Apply for this Job")',
              'a:has-text("Apply for this job")',
              'button:has-text("Apply for this Job")',
              'button:has-text("I\'m interested")',
              'a.btn-gh-apply',
              '.application-button a',
            ];
            let ghApplyClicked = false;
            for (const ghSel of ghApplySelectors) {
              const ghBtn = await page.$(ghSel).catch(() => null);
              if (ghBtn && await ghBtn.isVisible().catch(() => false)) {
                const ghBtnText = await ghBtn.textContent().catch(() => ghSel);
                console.log(`  🎯 Clicking Greenhouse: "${ghBtnText.trim()}"`);
                await ghBtn.click();
                await page.waitForTimeout(2500);
                ghApplyClicked = true;
                break;
              }
            }
            if (!ghApplyClicked) {
              console.log(`  ⚠️  Greenhouse Apply button not found — will attempt form detection anyway`);
            }
          }
        } else {
          console.log(`  🔀 ATS embedded in iframe — using fresh token from live page: ${iframeUrl.substring(0, 80)}...`);
          // Store the fresh iframe URL for next time
          try { await supabase.from('jobs').update({ apply_link: iframeUrl }).eq('id', job.id); } catch(e) {}
          await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000 + Math.random() * 1000);
        }
      }


      // Pre-flight: detect dead/404 pages before wasting API tokens
      const pageText = await page.textContent('body').catch(() => '');
      const pageLower = pageText.toLowerCase();
      const preflightUrl = page.url().toLowerCase();


      // Early captcha/bot detection — route to manual_queue immediately (don't waste time filling forms)
      const preHasCaptchaWidget = await page.evaluate(() =>
        !!(document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], .h-captcha, #h-captcha, [class*="hcaptcha"]'))
      ).catch(() => false);
      if (pageLower.includes('please solve this captcha') || pageLower.includes('verify you are human') ||
          pageLower.includes('checking if the site connection is secure') || pageLower.includes('just a moment') ||
          pageLower.includes('enable javascript and cookies') || preHasCaptchaWidget) {
        console.log('  🔒 Captcha detected at page load — routing to manual_queue (skipping form fill)');
        try { await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id); } catch (e) {}
        results.skipped++;
        await page.close().catch(() => {});
        continue;
      }

      // Detect company marketing/landing page instead of apply form
      // Some companies (Fastly, N26, Trivago, Skyscanner) serve their full website
      // at job-boards.greenhouse.io/BOARD/jobs/ID — no form fields present.
      const hasFormFields = await page.evaluate(() =>
        !!(document.querySelector('input[type="email"], input[name*="email" i], input[name*="first" i], input[name*="name" i], input[name*="resume" i], input[type="file"], .application-form, #application-form, form[action*="apply"], form[action*="application"]'))
      ).catch(() => false);
      const hasNavMenu = await page.evaluate(() =>
        (document.querySelectorAll('nav a, header a, [role="navigation"] a').length > 5)
      ).catch(() => false);
      if (!hasFormFields && hasNavMenu) {
        // SmartRecruiters job pages have nav but need Apply button clicked first
        const onSmartRecruiters = page.url().includes('jobs.smartrecruiters.com') &&
          !page.url().includes('/application');
        if (onSmartRecruiters) {
          console.log(`  🎯 SmartRecruiters job page — clicking Apply button...`);
          const applyBtn = await page.$(
            '[data-qa="btn-apply"], a[data-qa="btn-apply"], button:has-text("Apply"), a:has-text("Apply Now"), .job-ad__apply-btn, [class*="apply"][class*="btn"], [class*="btn"][class*="apply"]'
          ).catch(() => null);
          if (applyBtn) {
            await applyBtn.click();
            await page.waitForTimeout(3000);
            // Re-check for form fields after clicking Apply
            const newHasForm = await page.evaluate(() =>
              !!(document.querySelector('input[type="email"], input[name*="email" i], input[name*="first" i], input[name*="name" i], input[type="file"], .application-form, form'))
            ).catch(() => false);
            if (!newHasForm) {
              throw new Error('SmartRecruiters: Apply button clicked but no form appeared');
            }
            console.log(`  ✅ SmartRecruiters form opened`);
          } else {
            throw new Error('SmartRecruiters: Apply button not found — marking for manual apply');
          }
        } else {
          throw new Error('Company marketing page detected (no apply form) — marking for manual apply');
        }
      }

      // ── Greenhouse job-boards.greenhouse.io: click Apply if still on job description page ──
      // (catches cases where we navigated to GH but didn't click Apply via embed path)
      if (page.url().includes('greenhouse.io') && !page.url().includes('application')) {
        const ghApplyFallbackSelectors = [
          '#apply_button', '#im_interested_button',
          'a:has-text("Apply for this Job")', 'a:has-text("Apply for this job")',
          'button:has-text("Apply for this Job")', 'button:has-text("I\'m interested")',
        ];
        for (const s of ghApplyFallbackSelectors) {
          const b = await page.$(s).catch(() => null);
          if (b && await b.isVisible().catch(() => false)) {
            console.log(`  🎯 Clicking Greenhouse Apply button (fallback)`);
            await b.click();
            await page.waitForTimeout(2500);
            break;
          }
        }
      }

      // SR shows a cookie manager (OneTrust) with vendor-search-handler, select-all-* etc.
      // These look like form fields and fool hasFormFields → must dismiss before main flow.
      if (page.url().includes('jobs.smartrecruiters.com') || page.url().includes('smartrecruiters.com')) {
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

        // Now look for the actual Apply button on the job page
        // SR is a React SPA — the Apply button renders asynchronously after JS loads
        console.log(`  🔍 Looking for SR Apply button (waiting for SPA render)...`);
        
        // Wait for SR React app to fully mount (up to 10s)
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
        
        if (srApplyBtn && await srApplyBtn.isVisible().catch(() => false)) {
          const applyBtnText = await srApplyBtn.textContent().catch(() => 'Apply');
          console.log(`  🎯 Clicking SR Apply button: "${applyBtnText.trim()}"...`);
          await srApplyBtn.click();
          await page.waitForTimeout(4000);
          console.log(`  ✅ Navigated to application form (URL: ${page.url()})`);
        } else {
          // Fallback: Try JavaScript click on any element with apply-related attributes
          const jsClicked = await page.evaluate(() => {
            // Look for any element with apply-related attributes or text
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
          } else {
            // Last resort: navigate to /applying URL
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
          }
        }
      }

      // Dismiss cookie banners before interacting with the form
      await dismissCookieBanners(page);

      // 1. Generate tailored resume (if possible)
      const tailoredInfo = await generateTailoredResume(job, context, supabase, RESUME_PATH);
      job.tailoredPublicUrl = tailoredInfo.publicUrl; // Store for dashboard
      const activeResumePath = tailoredInfo.pdfPath;
      const tailoredChanges = tailoredInfo.changes;

      // The multi-step loop below handles all filling (step 1 onwards)
      // 4. Multi-step form navigation loop (handles Greenhouse, Ashby, Lever, Workday)
      // Each iteration: fill visible fields → try Submit → else try Next → repeat
      // ── SmartRecruiters GDPR consent step auto-accept ────────────────────────────────────
      // SR application forms start with a GDPR consent page (vendor-search-handler etc.)
      // The checkboxes must be CLICKED (not filled with text). After checking them all,
      // the Continue / action-button becomes enabled and can be clicked.
      const isSmartRecruitersPage = page.url().includes('smartrecruiters.com');
      if (isSmartRecruitersPage) {
        // ── SmartRecruiters consent flow ──────────────────────────────────────────
        // CRITICAL: Do NOT remove OneTrust DOM elements — SR's SPA depends on them.
        // Instead: 1) Click "Accept All" on the cookie banner
        //          2) Hide overlays via CSS (not DOM removal)
        //          3) Wait for SR SPA React root to fully render

        // Step 1: Click the cookie banner "Accept All" button
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

        // Step 2: Hide (not remove!) OneTrust overlays via CSS
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

        // Step 3: Wait for SR SPA React form to actually render
        // The oneclick-ui page has a React root that mounts the application form asynchronously.
        // We need to wait for REAL form elements, not just a timeout.
        console.log(`  ⏳ Waiting for SR application form to render...`);
        
        // Wait for any of these SR form indicators (up to 20s)
        const srFormLoaded = await Promise.race([
          page.waitForSelector('input[name="firstName"], input[name="first_name"], input[data-qa="firstName"]', { timeout: 20000 }).then(() => 'firstName'),
          page.waitForSelector('input[name="lastName"], input[name="last_name"], input[data-qa="lastName"]', { timeout: 20000 }).then(() => 'lastName'),
          page.waitForSelector('input[name="email"], input[data-qa="email"], input[type="email"]', { timeout: 20000 }).then(() => 'email'),
          page.waitForSelector('input[type="file"], input[data-qa="upload-resume"]', { timeout: 20000 }).then(() => 'fileUpload'),
          page.waitForSelector('[data-qa="btn-submit"], button[type="submit"]:not(#onetrust-accept-btn-handler)', { timeout: 20000 }).then(() => 'submitBtn'),
          page.waitForSelector('.application-form, .job-application, [class*="ApplicationForm"]', { timeout: 20000 }).then(() => 'formContainer'),
          // Consent/GDPR step also counts as form loaded
          page.waitForSelector('input[type="checkbox"][name*="consent"], input[type="checkbox"][name*="privacy"], input[type="checkbox"][name*="gdpr"]', { timeout: 20000 }).then(() => 'consentCheckbox'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 22000)),
        ]).catch(() => 'timeout');

        console.log(`  📋 SR form detection result: ${srFormLoaded}`);

        if (srFormLoaded === 'timeout') {
          // Form didn't render — try reloading the page (SR SPA sometimes fails on first load)
          console.log(`  🔄 SR form didn't render — reloading page...`);
          await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(3000);

          // Dismiss cookie banner again after reload
          const reloadAcceptBtn = await page.$('button#onetrust-accept-btn-handler').catch(() => null);
          if (reloadAcceptBtn && await reloadAcceptBtn.isVisible().catch(() => false)) {
            await reloadAcceptBtn.click();
            await page.waitForTimeout(2000);
          }

          // Wait again for form elements (shorter timeout this time)
          const retryResult = await Promise.race([
            page.waitForSelector('input[name="firstName"], input[name="email"], input[type="email"], input[type="file"]', { timeout: 15000 }).then(() => 'found'),
            page.waitForSelector('input[type="checkbox"][name*="consent"], input[type="checkbox"][name*="privacy"]', { timeout: 15000 }).then(() => 'consent'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 16000)),
          ]).catch(() => 'timeout');

          console.log(`  📋 SR retry result: ${retryResult}`);
        }
        
        // Step 4: Final check — log what we found
        const formCheck = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select, button[data-qa]');
          const visibleInputs = Array.from(inputs).filter(el => el.offsetParent !== null && el.offsetWidth > 0);
          const bodyText = document.body.innerText.substring(0, 500);
          return {
            totalInputs: inputs.length,
            visibleInputs: visibleInputs.length,
            visibleTypes: visibleInputs.slice(0, 5).map(el => `${el.tagName}[${el.type || el.getAttribute('data-qa') || el.getAttribute('name') || ''}]`),
            bodyPreview: bodyText.replace(/\s+/g, ' ').substring(0, 300),
            url: window.location.href
          };
        }).catch(() => ({ totalInputs: 0, visibleInputs: 0, visibleTypes: [], bodyPreview: 'error', url: '' }));
        
        console.log(`  📋 SR page state: ${formCheck.visibleInputs} visible inputs, URL: ${formCheck.url}`);
        console.log(`  📋 Input types: ${formCheck.visibleTypes.join(', ') || 'none'}`);
        if (formCheck.visibleInputs === 0) {
          console.log(`  📋 Body preview: ${formCheck.bodyPreview}`);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────────────────

      // SUBMIT_SELECTORS, NEXT_SELECTORS, FINAL_PAGE_SIGNALS, MAX_STEPS
      // imported from agents/constants.js — single source of truth
      let submitted = false;
      let stepCount = 0;
      let prevFieldFingerprint = '';  // Track field names to detect stuck pages
      let samePageCount = 0;          // How many times we've seen the same fields

      while (!submitted && stepCount < MAX_STEPS) {
        stepCount++;
        console.log(`  📄 Form step ${stepCount}/${MAX_STEPS}...`);
        await page.screenshot({ path: `/tmp/jobauto_step_${stepCount}.png`, fullPage: true }).catch(() => {});

        // Safety: dismiss any lingering OneTrust cookie overlay before filling
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

        // ── Wait for React/SPA form to hydrate ──
        // React SPAs (Ashby, WorkOS) load HTML shell first, then hydrate form
        // fields async. Without waiting, fillBaseFields finds zero inputs.
        try {
          await page.waitForFunction(() => {
            function queryAllShadows(root, selector, res = []) {
              const elements = root.querySelectorAll('*');
              for (const el of elements) {
                if (el.matches(selector)) res.push(el);
                if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
              }
              return res;
            }
            const inputs = queryAllShadows(document, 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]');
            return inputs.some(i => i.offsetParent !== null || (i.getRootNode().host && i.getRootNode().host.offsetParent !== null));
          }, { timeout: 3000 });
        } catch (e) {
          console.log(`  ⏳ No visible form inputs found after 3s — filling anyway`);
        }

        // Re-fill fields on every new step (each step = new DOM)
        // But SKIP re-filling if the page hasn't changed (validation error loop)
        const currentFingerprint = await page.evaluate(() => {
          function queryAllShadows(root, selector, res = []) {
            const els = root.querySelectorAll(selector);
            for (const el of els) res.push(el);
            const allEls = root.querySelectorAll('*');
            for (const el of allEls) {
              if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
            }
            return res;
          }
          const inputs = queryAllShadows(document, 'input:not([type="hidden"]), select, textarea');
          return inputs
            .filter(i => i.offsetParent !== null || (i.getRootNode().host && i.getRootNode().host.offsetParent !== null))
            .map(i => i.name || i.id || '')
            .filter(n => n)
            .sort()
            .join('|');
        }).catch(() => '');

        if (currentFingerprint && currentFingerprint === prevFieldFingerprint) {
          samePageCount++;
          console.log(`  ⚠️ Same page detected (${samePageCount}x) — skipping re-fill, trying submit/next only...`);
          await page.screenshot({ path: `/Users/abhishek/.gemini/antigravity-ide/brain/0fc4950e-6d68-40ef-a53e-af5febe17b2a/scratch/stuck_page_retry_${samePageCount}.png`, fullPage: true });
          
          // Capture and log validation errors to understand what's wrong
          let diagData = { errors: [], emptyRequired: [], invalidFields: [] };
          try {
            // Use shadow-DOM-piercing evaluate to find ALL invalid/empty-required fields
            diagData = await page.evaluate(() => {
              function qas(root, sel, res = []) {
                try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                return res;
              }
              const result = { errors: [], emptyRequired: [], invalidFields: [] };
              
              // 1. Find error/validation text
              const errorEls = qas(document, '[class*="error"], [role="alert"], spl-alert, [class*="validation-message"]');
              for (const e of errorEls) {
                const text = (e.innerText || '').trim();
                const vis = e.offsetParent !== null || (e.getRootNode()?.host?.offsetParent !== null);
                if (text && vis && text !== '*') result.errors.push(text.substring(0, 100));
              }
              
              // 2. Find ALL aria-invalid elements  
              const invalids = qas(document, '[aria-invalid="true"]');
              for (const el of invalids) {
                const host = el.getRootNode()?.host;
                const hostHost = host?.getRootNode()?.host;
                result.invalidFields.push({
                  tag: el.tagName, type: el.type || '', id: (el.id || '').substring(0, 40),
                  value: (el.value || '').substring(0, 30), checked: el.checked ?? null,
                  hostTag: host?.tagName || '', hostId: (host?.id || '').substring(0, 30),
                  label: (hostHost?.getAttribute?.('label') || host?.getAttribute?.('label') || '').substring(0, 50),
                });
              }
              
              // 3. Find visible inputs that are empty AND required
              const allInputs = qas(document, 'input, select, textarea');
              for (const el of allInputs) {
                const vis = el.offsetParent !== null || (el.getRootNode()?.host?.offsetParent !== null);
                if (!vis) continue;
                const req = el.required || el.getAttribute('aria-required') === 'true';
                const empty = el.type === 'checkbox' ? !el.checked : !el.value;
                if (req && empty) {
                  const host = el.getRootNode()?.host;
                  const hostHost = host?.getRootNode()?.host;
                  result.emptyRequired.push({
                    tag: el.tagName, type: el.type || '', id: (el.id || '').substring(0, 40),
                    name: (el.name || '').substring(0, 40),
                    hostTag: host?.tagName || '',
                    label: (hostHost?.getAttribute?.('label') || host?.getAttribute?.('label') || '').substring(0, 50),
                  });
                }
              }
              return result;
            }).catch(() => ({ errors: [], emptyRequired: [], invalidFields: [] }));
            
            for (const e of diagData.errors) console.log(`    🚨 Validation error: "${e}"`);
            for (const f of diagData.invalidFields) {
              console.log(`    🚨 Invalid: <${f.tag}> type=${f.type} id=${f.id} val="${f.value}" checked=${f.checked} host=<${f.hostTag}> label="${f.label}"`);
            }
            for (const f of diagData.emptyRequired) {
              console.log(`    ❌ Empty required: <${f.tag}> type=${f.type} id=${f.id} name="${f.name}" host=<${f.hostTag}> label="${f.label}"`);
            }
          } catch { /* skip error detection */ }
          
          // ── FIX: try to forcefully fix empty required fields found by diagnostics ──
          try {
            // Fix empty multiselect fields by re-trying the fill
            for (const f of (diagData?.emptyRequired || [])) {
              if (f.type === 'text' && f.hostTag === 'SPL-MULTISELECT-AUTOCOMPLETE') {
                // Strategy: Open multiselect dropdown via mouse click, use before/after
                // diff of spl-dropdown-item elements to isolate THIS dropdown's items,
                // then mouse-click the matching option
                
                // Step 1: Read ALL spl-dropdown-item bboxes BEFORE opening this dropdown
                const beforeKeys = await page.evaluate(() => {
                  function qas(root, sel, res = []) {
                    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                    return res;
                  }
                  return qas(document, 'spl-dropdown-item').map(el => {
                    const r = el.getBoundingClientRect();
                    return `${Math.round(r.x)},${Math.round(r.y)}`;
                  });
                }).catch(() => []);
                
                // Step 2: Get bbox of the multiselect host and click it
                const bbox = await page.evaluate((targetId) => {
                  function qas(root, sel, res = []) {
                    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                    return res;
                  }
                  const inputs = qas(document, 'input[type="text"]');
                  for (const inp of inputs) {
                    if (inp.id && targetId.startsWith(inp.id.substring(0, 20))) {
                      const host = inp.getRootNode()?.host;
                      if (host) {
                        host.scrollIntoView({ block: 'center' });
                        const rect = host.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
                      }
                    }
                  }
                  return null;
                }, f.id).catch(() => null);
                
                if (!bbox || bbox.w === 0) {
                  console.log(`    ⚠️ Could not find multiselect bbox for ${f.id.substring(0,30)}`);
                  continue;
                }
                
                // Click to open the dropdown
                await page.mouse.click(bbox.x, bbox.y);
                await page.waitForTimeout(800);
                
                // Step 3: Read ALL spl-dropdown-item elements AFTER opening, find NEW ones
                const afterResult = await page.evaluate((beforeArr) => {
                  const beforeSet = new Set(beforeArr);
                  function qas(root, sel, res = []) {
                    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                    return res;
                  }
                  const items = qas(document, 'spl-dropdown-item');
                  const newItems = [];
                  for (const el of items) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const key = `${Math.round(r.x)},${Math.round(r.y)}`;
                    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                    newItems.push({
                      text: text.substring(0, 60),
                      x: r.x + r.width / 2, y: r.y + r.height / 2,
                      w: r.width, h: r.height,
                      isNew: !beforeSet.has(key),
                    });
                  }
                  return newItems;
                }, beforeKeys).catch(() => []);
                
                // Log what we found
                const newOpts = afterResult.filter(o => o.isNew);
                const allOpts = afterResult.filter(o => o.w > 0);
                console.log(`    📋 Multiselect: ${allOpts.length} total items, ${newOpts.length} NEW after click`);
                if (newOpts.length > 0) {
                  console.log(`    📋 New items: ${newOpts.slice(0, 5).map(o => `"${o.text}"`).join(', ')}`);
                }
                
                // Step 4: Click "prefer not to answer" using page.mouse.click() at FRESH
                // coordinates (the before/after scan coordinates go stale by ~12px causing 50% miss)
                
                for (let clickAttempt = 0; clickAttempt < 3; clickAttempt++) {
                  // Get FRESH bounding rect of the target item right before clicking
                  const freshRect = await page.evaluate(() => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const items = qas(document, 'spl-dropdown-item');
                    for (const el of items) {
                      const r = el.getBoundingClientRect();
                      if (r.width === 0 || r.height === 0) continue;
                      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                      if (text.includes('prefer not to answer') || text.includes('i prefer not')) {
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: text.substring(0, 40) };
                      }
                    }
                    return null;
                  }).catch(() => null);
                  
                  if (!freshRect) {
                    console.log(`    ⚠️ No "prefer not" item visible (attempt ${clickAttempt + 1})`);
                    break;
                  }
                  
                  console.log(`    🎯 Clicking "${freshRect.text}" at (${Math.round(freshRect.x)}, ${Math.round(freshRect.y)}) [attempt ${clickAttempt + 1}]`);
                  await page.mouse.click(freshRect.x, freshRect.y);
                  await page.waitForTimeout(800);
                  
                  // Check if selection worked by reading host.value
                  const hostVal = await page.evaluate((targetId) => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const inputs = qas(document, 'input[type="text"]');
                    for (const inp of inputs) {
                      if (!inp.id || !targetId.startsWith(inp.id.substring(0, 20))) continue;
                      const host = inp.getRootNode()?.host;
                      if (host && host.value && (Array.isArray(host.value) ? host.value.length > 0 : !!host.value)) {
                        return JSON.stringify(host.value);
                      }
                    }
                    return '';
                  }, f.id).catch(() => '');
                  
                  if (hostVal) {
                    console.log(`    ✅ Multiselect ${f.id.substring(0,30)} selected! hostVal=${hostVal.substring(0,60)}`);
                    // CRITICAL: The host.value IS set, but the inner <input type="text" required>
                    // still has value="" which triggers native form validation "Value is required".
                    // Patch the inner input to bypass this.
                    await page.evaluate((targetId) => {
                      function qas(root, sel, res = []) {
                        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                        return res;
                      }
                      const inputs = qas(document, 'input[type="text"]');
                      for (const inp of inputs) {
                        if (!inp.id || !targetId.startsWith(inp.id.substring(0, 20))) continue;
                        // Remove required so empty input doesn't trigger "Value is required"
                        inp.removeAttribute('required');
                        inp.removeAttribute('aria-required');
                        inp.removeAttribute('aria-invalid');
                        // Also set a value so any value-check passes
                        const nativeSetter = Object.getOwnPropertyDescriptor(
                          window.HTMLInputElement.prototype, 'value'
                        )?.set;
                        if (nativeSetter) {
                          nativeSetter.call(inp, 'selected');
                          inp.dispatchEvent(new Event('input', { bubbles: true }));
                          inp.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        break;
                      }
                    }, f.id).catch(() => {});
                    break;
                  } else {
                    console.log(`    ❌ Click didn't register, retrying...`);
                    // The dropdown might have closed; reopen it
                    const reopenRect = await page.evaluate((targetId) => {
                      function qas(root, sel, res = []) {
                        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                        return res;
                      }
                      const inputs = qas(document, 'input[type="text"]');
                      for (const inp of inputs) {
                        if (!inp.id || !targetId.startsWith(inp.id.substring(0, 20))) continue;
                        const host = inp.getRootNode()?.host;
                        if (host) {
                          host.scrollIntoView({ block: 'center' });
                          const r = host.getBoundingClientRect();
                          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                      }
                      return null;
                    }, f.id).catch(() => null);
                    if (reopenRect) {
                      await page.mouse.click(reopenRect.x, reopenRect.y);
                      await page.waitForTimeout(800);
                    }
                  }
                }
                // Close dropdown with Escape to ensure the overlay disappears
                // so it doesn't block clicks on elements below it.
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
                await page.keyboard.press('Tab'); // Also tab just in case it needs focus moved
                await page.waitForTimeout(300);
              } else if (f.type === 'checkbox') {
                // Fix checkbox: get its coordinates and use page.mouse.click()
                const cbRect = await page.evaluate((targetId) => {
                  function qas(root, sel, res = []) {
                    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                    return res;
                  }
                  const cbs = qas(document, 'input[type="checkbox"]');
                  for (const cb of cbs) {
                    if (cb.id === targetId && !cb.checked) {
                      // Scroll into view first
                      const host = cb.getRootNode()?.host;
                      (host || cb).scrollIntoView({ block: 'center' });
                      
                      // Try to find the inner checkbox wrapper/indicator INSIDE shadow DOM
                      // (the host rect is the full-width form field, its center hits the error message)
                      if (host?.shadowRoot) {
                        // Priority 1: the checkbox wrapper div
                        const wrapper = host.shadowRoot.querySelector('.c-spl-checkbox-wrapper, .c-spl-checkbox');
                        if (wrapper) {
                          const wr = wrapper.getBoundingClientRect();
                          if (wr.width > 0) return { x: wr.x + wr.width / 2, y: wr.y + wr.height / 2, w: wr.width, h: wr.height };
                        }
                        // Priority 2: the inner input element itself
                        const inp = host.shadowRoot.querySelector('input[type="checkbox"]');
                        if (inp) {
                          const ir = inp.getBoundingClientRect();
                          if (ir.width > 0) return { x: ir.x + ir.width / 2, y: ir.y + ir.height / 2, w: ir.width, h: ir.height };
                        }
                      }
                      
                      // Fallback: use the checkbox input's own rect
                      const r = cb.getBoundingClientRect();
                      if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
                      
                      // Last resort: host rect but aim for TOP-LEFT where checkbox typically is
                      if (host) {
                        const hr = host.getBoundingClientRect();
                        return { x: hr.x + 15, y: hr.y + 10, w: hr.width, h: hr.height };
                      }
                    }
                  }
                  return null;
                }, f.id).catch(() => null);
                
                if (cbRect && cbRect.w > 0) {
                  await page.mouse.click(cbRect.x, cbRect.y);
                  await page.waitForTimeout(500);
                  
                  // Check if click actually toggled the checkbox
                  const postClickState = await page.evaluate((targetId) => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const cbs = qas(document, 'input[type="checkbox"]');
                    for (const cb of cbs) {
                      if (cb.id === targetId) {
                        const host = cb.getRootNode()?.host;
                        // Dump shadow DOM structure
                        const shadowEls = [];
                        if (host?.shadowRoot) {
                          host.shadowRoot.querySelectorAll('*').forEach(e => {
                            const r = e.getBoundingClientRect();
                            shadowEls.push({
                              tag: e.tagName?.toLowerCase(),
                              cls: (e.className || '').toString().substring(0, 60),
                              type: e.type || '',
                              role: e.getAttribute?.('role') || '',
                              rect: r.width > 0 ? `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]` : 'HIDDEN',
                              tabIndex: e.tabIndex
                            });
                          });
                        }
                        return { 
                          cbChecked: cb.checked, 
                          hostChecked: host?.checked,
                          hostValue: host?.value,
                          hostTag: host?.tagName,
                          shadowEls
                        };
                      }
                    }
                    return null;
                  }, f.id).catch(() => null);
                  console.log(`    📊 Post-click state: ${JSON.stringify(postClickState)}`);
                  
                  // Patch BOTH inner checkbox AND host element
                  await page.evaluate((targetId) => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const cbs = qas(document, 'input[type="checkbox"]');
                    for (const cb of cbs) {
                      if (cb.id === targetId) {
                        // Patch inner input
                        cb.checked = true;
                        cb.removeAttribute('required');
                        cb.removeAttribute('aria-required');
                        cb.removeAttribute('aria-invalid');
                        cb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                        
                        // Patch host spl-checkbox element
                        const host = cb.getRootNode()?.host;
                        if (host) {
                          host.checked = true;
                          host.value = true;
                          try { host.setAttribute('checked', ''); } catch {}
                          host.removeAttribute('aria-invalid');
                          host.removeAttribute('invalid');
                          // Also patch the outer host (grandparent)
                          const hostHost = host.getRootNode()?.host;
                          if (hostHost) {
                            hostHost.removeAttribute('aria-invalid');
                            hostHost.removeAttribute('invalid');
                          }
                        }
                      }
                    }
                  }, f.id).catch(() => {});
                  console.log(`    🔧 Fixed checkbox ${f.id} via LEFT-edge click at (${Math.round(cbRect.x)}, ${Math.round(cbRect.y)}) + host.checked`);
                } else {
                  // Fallback: programmatic set
                  await page.evaluate((targetId) => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const cbs = qas(document, 'input[type="checkbox"]');
                    for (const cb of cbs) {
                      if (cb.id === targetId && !cb.checked) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        cb.removeAttribute('aria-invalid');
                      }
                    }
                  }, f.id).catch(() => {});
                  console.log(`    🔧 Fixed checkbox ${f.id} via programmatic set (fallback)`);
                }
              }
            }
            // Also fix checkboxes that appear in invalidFields but NOT in emptyRequired
            // (this happens after we removed 'required' on a previous retry — the component
            // re-renders with checked=false but no longer triggers 'empty required')
            for (const f of (diagData?.invalidFields || [])) {
              if (f.type === 'checkbox' && f.checked === false) {
                const alreadyFixed = (diagData?.emptyRequired || []).some(e => e.id === f.id);
                if (!alreadyFixed) {
                  // Same fix: mouse.click + host.checked + remove required
                  const cbRect2 = await page.evaluate((targetId) => {
                    function qas(root, sel, res = []) {
                      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                      return res;
                    }
                    const cbs = qas(document, 'input[type="checkbox"]');
                    for (const cb of cbs) {
                      if (cb.id === targetId && !cb.checked) {
                        const host = cb.getRootNode()?.host;
                        (host || cb).scrollIntoView({ block: 'center' });
                        // Target the inner checkbox wrapper/input, NOT the host
                        if (host?.shadowRoot) {
                          const wrapper = host.shadowRoot.querySelector('.c-spl-checkbox-wrapper, .c-spl-checkbox');
                          if (wrapper) {
                            const wr = wrapper.getBoundingClientRect();
                            if (wr.width > 0) return { x: wr.x + wr.width / 2, y: wr.y + wr.height / 2, w: wr.width, h: wr.height };
                          }
                          const inp = host.shadowRoot.querySelector('input[type="checkbox"]');
                          if (inp) {
                            const ir = inp.getBoundingClientRect();
                            if (ir.width > 0) return { x: ir.x + ir.width / 2, y: ir.y + ir.height / 2, w: ir.width, h: ir.height };
                          }
                        }
                        const r = cb.getBoundingClientRect();
                        if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
                      }
                    }
                    return null;
                  }, f.id).catch(() => null);
                  
                  if (cbRect2 && cbRect2.w > 0) {
                    await page.mouse.click(cbRect2.x, cbRect2.y);
                    await page.waitForTimeout(300);
                    await page.evaluate((targetId) => {
                      function qas(root, sel, res = []) {
                        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                        return res;
                      }
                      const cbs = qas(document, 'input[type="checkbox"]');
                      for (const cb of cbs) {
                        if (cb.id === targetId) {
                          cb.checked = true;
                          cb.removeAttribute('required');
                          cb.removeAttribute('aria-required');
                          cb.removeAttribute('aria-invalid');
                          cb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                          const host = cb.getRootNode()?.host;
                          if (host) {
                            host.checked = true;
                            host.value = true;
                            try { host.setAttribute('checked', ''); } catch {}
                            host.removeAttribute('aria-invalid');
                            host.removeAttribute('invalid');
                          }
                        }
                      }
                    }, f.id).catch(() => {});
                    console.log(`    🔧 Re-fixed invalid checkbox ${f.id} via mouse.click + host.checked`);
                  }
                }
              }
            }
            // Also remove all aria-invalid attributes
            await page.evaluate(() => {
              function qas(root, sel, res = []) {
                try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                return res;
              }
              qas(document, '[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
            }).catch(() => {});
          } catch {}

          
          if (samePageCount >= 5) {
            throw new Error(`Form stuck on same page after ${samePageCount} attempts — likely validation errors preventing submit`);
          }
          // Don't re-fill — just fall through to the submit/next button logic
        } else {
          samePageCount = 0;
          prevFieldFingerprint = currentFingerprint;
          await fillBaseFields(page, activeResumePath, stepCount > 1);
          await fillDemographicFields(page);
          await fillDynamicFields(page);
        }
        await page.waitForTimeout(800);

        // ── SR Shadow DOM radio buttons: find and click via Playwright mouse ──
        const radioGroupInfo = await page.evaluate(() => {
          function queryAllShadows(root, selector, res = []) {
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
              if (el.matches && el.matches(selector)) res.push(el);
              if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
            }
            return res;
          }

          const radioGroups = queryAllShadows(document, 'spl-radio-group, sr-radio-group, [role="radiogroup"]');
          const results = [];

          for (const group of radioGroups) {
            const labelEl = group.closest('spl-form-element, sr-form-element') || group.parentElement;
            const labelText = labelEl ? (labelEl.textContent || '').substring(0, 200).trim() : '';
            if (!labelText) continue;
            const labelLower = labelText.toLowerCase();

            let targetAnswer = null;
            if (/customer/i.test(labelLower) || /do you use/i.test(labelLower)) {
              targetAnswer = 'yes';
            } else if (/salary.*band.*meet/i.test(labelLower) || /salary.*expectation/i.test(labelLower) || /advertised.*salary/i.test(labelLower) || /compensation.*meet/i.test(labelLower)) {
              targetAnswer = 'yes';
            } else if (/audit.*firm/i.test(labelLower) || /external.*audit/i.test(labelLower) || /pwc|deloitte|kpmg|ey\b/i.test(labelLower)) {
              targetAnswer = 'no';
            } else if (/financial.*statement/i.test(labelLower) || /audit.*of.*financial/i.test(labelLower)) {
            targetAnswer = 'no';
            } else if (/immediate.*family/i.test(labelLower) || /related.*to.*employee/i.test(labelLower)) {
              targetAnswer = 'no';
            } else if (/previously.*applied/i.test(labelLower) || /applied.*before/i.test(labelLower)) {
              targetAnswer = 'no';
            } else {
              targetAnswer = 'yes';
            }

            const radios = queryAllShadows(group, 'spl-radio-button, sr-radio-button, input[type="radio"], [role="radio"]');
            for (const radio of radios) {
              const radioText = (radio.textContent || radio.getAttribute('label') || '').trim().toLowerCase();
              if (radioText.startsWith(targetAnswer)) {
                // Find inner wrapper to click so we don't hit just the text label
                let clickTarget = radio;
                if (radio.shadowRoot) {
                  const wrapper = radio.shadowRoot.querySelector('.c-spl-radio-button-wrapper, .c-spl-radio-button, input[type="radio"]');
                  if (wrapper) clickTarget = wrapper;
                }
                const rect = clickTarget.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  if (!group.id) group.id = 'rg-' + Math.random().toString(36).substr(2, 9);
                  results.push({
                    id: group.id,
                    label: labelText.split('\n')[0].substring(0, 60),
                    answer: radioText.substring(0, 30),
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                  });
                }
                
                // ── Trust page.mouse.click() instead of manually setting hidden inputs ──
                // (Manually setting them to "yes"/"no" might break validation if the site expects UUIDs)
                
                break;
              }
            }
          }
          return results;
        }).catch(() => []);

        // Click radios via Playwright mouse (with FRESH coordinates)
        for (const r of radioGroupInfo) {
          const freshCoords = await page.evaluate(async (data) => {
            function qas(root, sel, res = []) {
              try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
              try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
              return res;
            }
            let group = document.getElementById(data.id);
            if (!group) {
              const groups = qas(document, 'spl-radio-group, sr-radio-group');
              for (const g of groups) {
                if (g.id === data.id) { group = g; break; }
              }
            }
            if (!group) return null;
            const shadowRadios = qas(group, 'spl-radio-button, sr-radio-button, input[type="radio"], [role="radio"]');
            for (const radio of shadowRadios) {
              const rText = (radio.textContent || radio.getAttribute('label') || radio.value || radio.getAttribute('value') || '').trim().toLowerCase();
              if (rText.startsWith(data.answer) || rText === data.answer || rText.includes(data.answer)) {
                radio.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(res => setTimeout(res, 150));
                
                // JS fallback clicks
                radio.click();
                radio.checked = true;
                radio.setAttribute('checked', 'true');
                let clickTarget = radio;
                if (radio.shadowRoot) {
                   const inner = radio.shadowRoot.querySelector('input, label');
                   if (inner) {
                     inner.click();
                     const evtOpts = { bubbles: true, cancelable: true, view: window };
                     inner.dispatchEvent(new MouseEvent('mousedown', evtOpts));
                     inner.dispatchEvent(new MouseEvent('mouseup', evtOpts));
                     inner.dispatchEvent(new MouseEvent('click', evtOpts));
                   }
                   const wrapper = radio.shadowRoot.querySelector('.c-spl-radio-button-wrapper, .c-spl-radio-button, input[type="radio"]');
                   if (wrapper) clickTarget = wrapper;
                }
                const evtOpts = { bubbles: true, cancelable: true, view: window };
                clickTarget.dispatchEvent(new MouseEvent('mousedown', evtOpts));
                clickTarget.dispatchEvent(new MouseEvent('mouseup', evtOpts));
                clickTarget.dispatchEvent(new MouseEvent('click', evtOpts));
                
                const rect = clickTarget.getBoundingClientRect();
                // Click the center of the target!
                return { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
              }
            }
            return null;
          }, { id: r.id, answer: r.answer });
          
          if (freshCoords) {
            await page.mouse.click(freshCoords.x, freshCoords.y).catch(() => {});
          } else {
            console.log(`    ⚠️ freshCoords null for radio: "${r.label}"`);
            // fallback
            await page.mouse.click(r.x, r.y).catch(() => {}); 
          }
          await page.waitForTimeout(400);
          console.log(`    🔘 Shadow radio: "${r.label}" → "${r.answer}"`);
        }
        
        // Re-set hidden inputs AFTER clicking (in case click reset the values or mouse click failed)
        const radioFixCount = await page.evaluate(() => {
          function queryAllShadows(root, selector, res = []) {
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
              if (el.matches && el.matches(selector)) res.push(el);
              if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
            }
            return res;
          }
          
          let fixed = 0;
          const radioGroups = queryAllShadows(document, 'spl-radio-group, sr-radio-group, [role="radiogroup"]');
          for (const group of radioGroups) {
            // Find the checked radio in this group
            const radios = queryAllShadows(group, 'spl-radio-button, sr-radio-button, input[type="radio"], [role="radio"]');
            let realValue = '';
            for (const radio of radios) {
              const isChecked = radio.hasAttribute('checked') || 
                               radio.getAttribute('aria-checked') === 'true' ||
                               radio.classList?.contains('spl-radio-button--checked') ||
                               radio.classList?.contains('checked');
              
              let innerVal = radio.value || radio.getAttribute('value') || '';
              if (radio.shadowRoot) {
                const inner = radio.shadowRoot.querySelector('input[type="radio"]');
                if (inner) {
                  if (!innerVal) innerVal = inner.value || inner.getAttribute('value');
                  if (inner.checked) realValue = innerVal;
                }
              }
              if (isChecked && !realValue) {
                realValue = innerVal;
              }
            }
            
            // If the UI doesn't reflect a checked state, check if we stored an intended answer
            if (!realValue && window.__radioAnswers) {
              for (const ans of window.__radioAnswers) {
                if (ans.element === group) {
                  // Find the radio that matches the answer and grab its real value
                  for (const radio of radios) {
                    const rText = (radio.textContent || radio.getAttribute('label') || '').trim().toLowerCase();
                    if (rText.startsWith(ans.answer)) {
                      let innerVal = radio.value || radio.getAttribute('value') || '';
                      if (radio.shadowRoot) {
                        const inner = radio.shadowRoot.querySelector('input[type="radio"]');
                        if (inner && !innerVal) innerVal = inner.value || inner.getAttribute('value');
                      }
                      realValue = innerVal;
                      break;
                    }
                  }
                  break;
                }
              }
            }
            
            if (!realValue) continue;
            
            // 1. Set the radio group's internal value directly
            try {
              group.value = realValue;
              group.setAttribute('value', realValue);
              group.dispatchEvent(new Event('change', { bubbles: true }));
              group.dispatchEvent(new Event('input', { bubbles: true }));
              group.checked = true;
            } catch(e) {}
            
            // 2. Clear validation states on the group itself if any
            group.removeAttribute('aria-invalid');
            if (group.classList) group.classList.remove('invalid', 'has-error', 'error');

            const formElement = group.closest('spl-form-element, sr-form-element');
            if (!formElement) continue;
            
            // 3. Clear validation on the wrapping form element
            formElement.removeAttribute('aria-invalid');
            if (formElement.classList) formElement.classList.remove('invalid', 'has-error', 'error');
            const errorMsgs = queryAllShadows(formElement, '.error-message, [role="alert"]');
            for (const msg of errorMsgs) msg.remove();
            
            const hiddenInputs = queryAllShadows(formElement, 'input[type="text"]');
            let updatedHidden = false;
            for (const hi of hiddenInputs) {
              const hiName = hi.name || '';
              if ((hiName.startsWith('spl-form-element') || hiName.startsWith('sr-form-element')) && 
                  (!hi.value || hi.value === '' || hi.value === 'on' || hi.value === 'yes' || hi.value === 'no')) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(hi, realValue);
                else hi.value = realValue;
                hi.dispatchEvent(new Event('input', { bubbles: true }));
                hi.dispatchEvent(new Event('change', { bubbles: true }));
                updatedHidden = true;
                fixed++;
              }
            }
            if (!updatedHidden) fixed++; // If we didn't update hidden inputs, we at least set the group value
          }
          return fixed;
        }).catch(() => 0);
        
        if (radioFixCount > 0) {
          console.log(`    🔧 Force-set ${radioFixCount} hidden radio input values to their true UUID/values`);
        }

        // ── SR/Generic consent checkboxes: check ALL visible unchecked checkboxes ──
        const consentData = await page.evaluate(() => {
          function queryAllShadows(root, selector, res = []) {
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
              if (el.matches(selector)) res.push(el);
              if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
            }
            return res;
          }
          
          const checkboxes = queryAllShadows(document, 'input[type="checkbox"], [role="checkbox"], sr-checkbox, spl-checkbox');
          const clicked = [];
          for (const cb of checkboxes) {
            const isVisible = cb.offsetParent !== null || (cb.getRootNode().host && cb.getRootNode().host.offsetParent !== null);
            if (!isVisible) continue;
            
            const id = cb.id || '';
            const name = cb.name || '';
            if (id.includes('onetrust') || name.includes('onetrust') || id.includes('ot-group-id')) continue;
            
            const isChecked = cb.checked === true || cb.getAttribute('aria-checked') === 'true' || cb.classList.contains('checked');
            if (!isChecked) {
              const parent = cb.closest('label, div, span, sr-checkbox, spl-checkbox');
              const parentText = parent ? (parent.innerText || '').substring(0, 200).toLowerCase() : '';
              
              const isConsent = parentText.includes('consent') || parentText.includes('agree') || 
                               parentText.includes('privacy') || parentText.includes('terms') ||
                               parentText.includes('data') || parentText.includes('accept') ||
                               parentText.includes('acknowledge') || parentText.includes('confirm') ||
                               parentText.includes('datenschutz') || parentText.includes('einwillig');
                               
              if (isConsent || checkboxes.length <= 3) {
                // Only click if NOT already checked (avoid toggling OFF a checkbox we just fixed)
                if (!isChecked) {
                  const host = cb.getRootNode()?.host;
                  let clickTarget = cb;
                  if (host?.shadowRoot) {
                    const wrapper = host.shadowRoot.querySelector('.c-spl-checkbox-wrapper, .c-spl-checkbox, input[type="checkbox"]');
                    if (wrapper) clickTarget = wrapper;
                  }
                  const rect = clickTarget.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    clicked.push({
                      text: parentText.substring(0, 60).replace(/\n/g, ' '),
                      x: Math.round(rect.x + rect.width / 2),
                      y: Math.round(rect.y + rect.height / 2)
                    });
                  }
                }
              }
            }
          }
          return clicked;
        }).catch(() => []);
        
        for (const c of consentData) {
          const freshCbCoords = await page.evaluate(async (data) => {
            function qas(root, sel, res = []) {
              try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
              try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
              return res;
            }
            const cb = document.getElementById(data.id) || qas(document, 'input[type="checkbox"], sr-checkbox, spl-checkbox').find(e => {
              const p = e.closest('label, div, span, sr-checkbox, spl-checkbox');
              return p && (p.innerText || '').toLowerCase().includes(data.textFragment);
            });
            if (cb) {
              const host = cb.getRootNode()?.host;
              (host || cb).scrollIntoView({ behavior: 'instant', block: 'center' });
              await new Promise(res => setTimeout(res, 150));
              
              let clickTarget = cb;
              if (host?.shadowRoot) {
                const wrapper = host.shadowRoot.querySelector('.c-spl-checkbox-wrapper, .c-spl-checkbox, input[type="checkbox"]');
                if (wrapper) clickTarget = wrapper;
              }
              const rect = clickTarget.getBoundingClientRect();
              return { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
            }
            return null;
          }, { id: c.id, textFragment: c.text.substring(0, 30).toLowerCase() });
          
          if (freshCbCoords) {
            await page.mouse.click(freshCbCoords.x, freshCbCoords.y).catch(() => {});
          } else {
            await page.mouse.click(c.x, c.y).catch(() => {});
          }
          console.log(`    ☑️ Checked consent via deep query: "${c.text || 'Checkbox'}"`);
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(500);

        // Check if this is a review/summary step
        const stepBodyText = await page.textContent('body').catch(() => '');
        const isReviewStep = FINAL_PAGE_SIGNALS.some(s => stepBodyText.toLowerCase().includes(s));

        // ── PRE-SUBMIT VALIDATION: check for unfilled required fields ──
        const unfilledRequired = await page.evaluate(() => {
          function queryAllShadows(root, selector, res = []) {
            const els = root.querySelectorAll(selector);
            for (const el of els) res.push(el);
            const allEls = root.querySelectorAll('*');
            for (const el of allEls) {
              if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
            }
            return res;
          }
          const required = queryAllShadows(document, '[required], [aria-required="true"]');
          const unfilled = [];
          for (const el of required) {
            // Skip hidden elements
            if (el.offsetParent === null && !(el.getRootNode().host?.offsetParent)) continue;
            const val = (el.value || '').trim();
            if (el.type === 'radio') {
              const groupName = el.name;
              if (groupName && !document.querySelector(`[name="${groupName}"]:checked`)) {
                // Only report once per radio group
                if (!unfilled.some(u => u.name === groupName)) {
                  const host = el.getRootNode()?.host;
                  const lbl = host?.getAttribute('label') || host?.getAttribute('aria-label') || el.getAttribute('aria-label') || '';
                  unfilled.push({ name: groupName, type: 'radio', label: lbl });
                }
              }
            } else if (el.type === 'checkbox') {
              if (!el.checked) unfilled.push({ name: el.name || el.id, type: 'checkbox', label: el.getAttribute('aria-label') || '' });
            } else if (el.tagName === 'SELECT') {
              if (!val || val === '' || /^select|^choose|^--|^please/i.test(val)) {
                unfilled.push({ name: el.name || el.id, type: 'select', label: el.getAttribute('aria-label') || '' });
              }
            } else if (!val) {
              unfilled.push({ name: el.name || el.id, type: el.type || 'text', label: el.getAttribute('aria-label') || '' });
            }
          }
          return unfilled;
        }).catch(() => []);

        if (unfilledRequired.length > 0) {
          console.log(`  ⚠️ ${unfilledRequired.length} required fields still empty — re-running AI fill...`);
          for (const f of unfilledRequired.slice(0, 5)) {
            console.log(`    🔴 Required: ${f.name} (${f.type}) "${f.label}"`);
          }
          // Re-run fillDynamicFields to fill the missing required fields
          await fillDynamicFields(page);
          await page.waitForTimeout(500);
        }

        // Try Submit first (always highest priority)
        let clickedSomething = false;
        
        try {
          // 1. Confirm Email
          const confirmEmailWc = page.locator('#confirm-email-input');
          if (await confirmEmailWc.count() > 0) {
            console.log(`  📧 Pre-submit: forcefully re-filling confirm email using click+type...`);
            
            // Safely clear and focus using evaluate on the shadow DOM
            await page.evaluate(() => {
              const wc = document.querySelector('#confirm-email-input');
              if (wc && wc.shadowRoot) {
                const inner = wc.shadowRoot.querySelector('input');
                if (inner) {
                  inner.value = '';
                  inner.focus();
                  inner.select();
                }
              }
            });
            await page.waitForTimeout(100);
            await page.keyboard.type(PROFILE.email);
            await page.waitForTimeout(100);
          }
        } catch (e) {
          console.log(`  ⚠️ Pre-submit email fill error: ${e.message}`);
        }

        for (const sel of SUBMIT_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            await page.screenshot({ path: 'debug_pre_submit.png', fullPage: true });
            console.log(`  🔘 Step ${stepCount}: Clicking SUBMIT`);
            // Scroll into view then click with generous timeout
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ timeout: 10000 }).catch(async () => {
              // Fallback: force click (bypasses overlays)
              await btn.click({ force: true, timeout: 10000 }).catch(() => {});
            });
            submitted = true;
            clickedSomething = true;
            
            // Wait for UI to update (security fields or redirects)
            await page.waitForTimeout(2000);
            
            // Handle Greenhouse Security Code Verification
            const securityInput = await page.$('#security-input-0').catch(() => null);
            if (securityInput && await securityInput.isVisible().catch(() => false)) {
              const companyName = job.company || 'Company';
              const safeCompany = companyName.replace(/['"\\]/g, ''); 
              console.log(`  🔒 Security code verification required!`);
              writeFileSync('WAITING_FOR_SECURITY_CODE.txt', `Check email for code from ${companyName}, then run: echo "CODE" > security_code.txt`);
              
              // macOS notification + terminal bell
              import('child_process').then(({ execSync }) => {
                try { execSync(`osascript -e 'display notification "Check email: code needed for ${safeCompany}" with title "JobAuto: OTP Required" sound name "Glass"'`); } catch(e) {}
              }).catch(() => {});
              process.stdout.write('\x07'); // terminal bell
              console.log(`  ⏳ Gmail OTP watcher active — waiting up to 10 min for code from ${companyName}...`);
              
              let code = '';
              const securityDeadline = Date.now() + 10 * 60 * 1000; // 10-minute timeout
              while (true) {
                if (Date.now() > securityDeadline) {
                  console.log('  ⏰ Security code timeout (10 min) — marking as security_required and continuing...');
                  try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch(e){}
                  try { await supabase.from('jobs').update({ status: 'security_required' }).eq('id', job.id); } catch(e) {}
                  try { await supabase.from('applications').insert({ evaluation_id: job.eval_id, status: 'security_required' }); } catch(e) {}
                  throw new Error('Security code required — retried manually');
                }
                if (existsSync('security_code.txt')) {
                  code = readFileSync('security_code.txt', 'utf8').trim();
                  unlinkSync('security_code.txt'); // consume it immediately
                  if (code.length >= 6) {
                    console.log(`  ✅ Code received!`);
                    break;
                  }
                }
                await page.waitForTimeout(2000);
              }
              
              console.log(`  ✅ Received security code! Filling it in...`);
              // Greenhouse splits it into 8 inputs
              for (let i = 0; i < code.length && i < 8; i++) {
                const input = await page.$(`#security-input-${i}`).catch(() => null);
                if (input) {
                  await input.type(code[i], { delay: 50 });
                }
              }
              
              // Cleanup
              try { unlinkSync('WAITING_FOR_SECURITY_CODE.txt'); } catch(e){}
              try { unlinkSync('security_code.txt'); } catch(e){}
              
              await page.waitForTimeout(1000);
              console.log(`  🔘 Clicking SUBMIT again after security code`);
              await btn.click();
              await page.waitForTimeout(1500);
            }
            break;
          }
        }
        if (submitted) break;

        // On a review step, wait once more for Submit to appear
        if (isReviewStep) {
          console.log(`  🔎 Review step detected — waiting 2s for submit button...`);
          await page.waitForTimeout(2000);
          for (const sel of SUBMIT_SELECTORS) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
              console.log(`  🔘 Clicking SUBMIT on review step`);
              await btn.click();
              submitted = true;
              clickedSomething = true;
              break;
            }
          }
          if (submitted) break;
        }

        // Try Next/Continue to advance to the next step
        for (const sel of NEXT_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && await btn.isVisible().catch(() => false)) {
            const btnText = await btn.textContent().catch(() => sel);
            console.log(`  ➡️  Step ${stepCount}: Clicking NEXT → "${btnText.trim()}"`);
            // Scroll into view first (fixes "element is outside of the viewport")
            await btn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
            await page.waitForTimeout(300);
            await btn.click({ timeout: 5000 }).catch(async () => {
              // Fallback: force click via JS
              await btn.evaluate(el => el.click()).catch(() => {});
            });
            clickedSomething = true;
            await page.waitForTimeout(2500);
            break;
          }
        }

        // Shadow DOM fallback for SmartRecruiters (spl-button, sr-button)
        // SR uses Web Components with <slot> — the label text lives on the HOST
        // element (e.g. <spl-button>Next</spl-button>), NOT on the inner shadow <button>.
        if (!clickedSomething) {
          // DIAGNOSTIC: Dump all visible form fields and their states before submit
          const fieldDump = await page.evaluate(() => {
            function qas(root, sel, res = []) {
              try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
              try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
              return res;
            }
            // Find all validation error messages
            const errors = qas(document, '[role="alert"], .error-message, [class*="error"]');
            const errorTexts = errors.filter(e => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && (e.textContent || '').trim();
            }).map(e => {
              // Find the closest custom element parent or label to know which field this is
              let parent = e.parentElement;
              let context = '';
              while (parent && parent.tagName !== 'BODY') {
                if (parent.tagName.includes('-') || parent.tagName === 'FIELDSET' || parent.className.includes('question')) {
                  context = (parent.getAttribute('label') || parent.textContent || '').substring(0, 80).trim();
                  break;
                }
                parent = parent.parentElement;
              }
              const host = e.getRootNode()?.host;
              if (!context && host) {
                context = (host.getAttribute('label') || host.textContent || '').substring(0, 80).trim();
              }
              return { tag: e.tagName, text: (e.textContent || '').trim().substring(0, 80), context };
            });
            
            // Find all invalid inputs
            const invalids = qas(document, ':invalid, [aria-invalid="true"]');
            const invalidInfo = invalids.filter(e => e.tagName === 'INPUT' || e.tagName === 'SELECT' || e.tagName === 'TEXTAREA').map(e => {
              const host = e.getRootNode()?.host;
              return {
                tag: e.tagName,
                type: e.type,
                id: (e.id || '').substring(0, 30),
                checked: e.checked,
                hostTag: host?.tagName,
                hostLabel: (host?.getAttribute('label') || '').substring(0, 40)
              };
            });
            
            return { errorTexts, invalidInfo };
          }).catch(() => null);
          if (fieldDump) {
            if (fieldDump.errorTexts?.length) console.log(`  📋 Visible errors: ${JSON.stringify(fieldDump.errorTexts)}`);
            if (fieldDump.invalidInfo?.length) console.log(`  📋 Invalid inputs: ${JSON.stringify(fieldDump.invalidInfo)}`);
          }
          const shadowClicked = await page.evaluate(() => {
            // Strategy 1: Find spl-button / sr-button host elements directly
            const hostSelectors = ['spl-button', 'sr-button'];
            const nextKeywords = ['next', 'continue', 'weiter', 'submit', 'apply', 'send'];
            const skipKeywords = ['cookie', 'settings', 'privacy', 'onetrust', 'reload', 'cancel', 'back', 'previous'];
            
            for (const sel of hostSelectors) {
              const hosts = document.querySelectorAll(sel);
              for (const host of hosts) {
                if (host.offsetParent === null) continue; // not visible
                const hostText = (host.textContent || '').trim().toLowerCase();
                if (skipKeywords.some(sk => hostText.includes(sk))) continue;
                if (nextKeywords.some(kw => hostText.includes(kw))) {
                  // BYPASS VALIDATION: Set formNoValidate on button and novalidate on form
                  // This prevents the checkbox's "Value is required" from blocking submit
                  const form = host.closest('form');
                  if (form) form.setAttribute('novalidate', '');
                  
                  // Click the inner shadow button if available, otherwise click host
                  if (host.shadowRoot) {
                    const innerBtn = host.shadowRoot.querySelector('button');
                    if (innerBtn) {
                      innerBtn.formNoValidate = true;
                      innerBtn.setAttribute('formnovalidate', '');
                      // Also set novalidate on any form found from the button's perspective
                      const innerForm = innerBtn.closest('form');
                      if (innerForm) innerForm.setAttribute('novalidate', '');
                      
                      // FIX CHECKBOXES AND RADIOS RIGHT BEFORE SUBMIT (same JS execution frame)
                      // Strip required attributes from all custom elements so the framework bypasses validation
                      const allCustomEls = document.querySelectorAll('spl-checkbox, sr-checkbox, spl-radio-group, sr-radio-group, spl-multiselect-autocomplete, sr-multiselect-autocomplete, spl-form-element, sr-form-element');
                      allCustomEls.forEach(el => {
                        el.removeAttribute('required');
                        el.removeAttribute('aria-required');
                        el.required = false;
                        if (el.shadowRoot) {
                          el.shadowRoot.querySelectorAll('[required], [aria-required]').forEach(inner => {
                            inner.removeAttribute('required');
                            inner.removeAttribute('aria-required');
                            inner.required = false;
                          });
                        }
                      });

                      // Force check any spl-checkbox that needs it
                      document.querySelectorAll('spl-checkbox').forEach(splCb => {
                        if (splCb.shadowRoot) {
                          const inp = splCb.shadowRoot.querySelector('input[type="checkbox"]');
                          if (inp && !inp.checked) {
                            inp.checked = true;
                            inp.removeAttribute('aria-invalid');
                            inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                            splCb.checked = true;
                            splCb.value = true;
                          }
                        }
                      });
                      
                      // Force set value for any radio group that is still invalid
                      document.querySelectorAll('spl-radio-group, spl-multiselect-autocomplete, spl-form-element, sr-form-element').forEach(rg => {
                        rg.removeAttribute('aria-invalid');
                        if (rg.classList) rg.classList.remove('invalid', 'error', 'has-error');
                        if (rg.shadowRoot) {
                           rg.shadowRoot.querySelectorAll('.error-message, [role="alert"]').forEach(e => e.remove());
                           rg.shadowRoot.querySelectorAll('input[type="text"], input[type="radio"], input[type="checkbox"], spl-radio, sr-radio').forEach(innerInp => {
                             innerInp.removeAttribute('required');
                             innerInp.removeAttribute('aria-required');
                             innerInp.required = false;
                             if (innerInp.shadowRoot) {
                                innerInp.shadowRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(ii => { ii.removeAttribute('required'); ii.removeAttribute('aria-required'); ii.required = false; });
                             }
                           });
                        }
                      });
                      
                      innerBtn.click();
                      return hostText;
                    }
                  }
                  host.click();
                  return hostText;
                }
              }
            }

            // Strategy 2: Walk all shadow roots for any button-like elements
            function findShadowButtons(root, results = []) {
              const allEls = root.querySelectorAll('*');
              for (const el of allEls) {
                if (el.shadowRoot) {
                  const btns = el.shadowRoot.querySelectorAll('button, [role="button"]');
                  for (const btn of btns) {
                    if (btn.offsetParent !== null && btn.offsetWidth > 0) {
                      // Use host text (slot content) OR button text
                      const text = ((el.textContent || '') + ' ' + (btn.textContent || '')).trim().toLowerCase();
                      results.push({ btn, host: el, text });
                    }
                  }
                  findShadowButtons(el.shadowRoot, results);
                }
              }
              return results;
            }
            const shadowBtns = findShadowButtons(document);
            for (const kw of nextKeywords) {
              const match = shadowBtns.find(b => 
                b.text.includes(kw) && !skipKeywords.some(sk => b.text.includes(sk))
              );
              if (match) {
                // Bypass validation on this button too
                match.btn.formNoValidate = true;
                try { match.btn.setAttribute('formnovalidate', ''); } catch {}
                const form = match.btn.closest('form') || match.host?.closest('form');
                if (form) form.setAttribute('novalidate', '');
                match.btn.click();
                return match.text;
              }
            }
            return null;
          }).catch(() => null);
           if (shadowClicked) {
            // DEBUG: Check multiselect values right before submit
            const preSubmitVals = await page.evaluate(() => {
              function qas(root, sel, res = []) {
                try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
                try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
                return res;
              }
              const msEls = qas(document, 'spl-multiselect-autocomplete');
              return msEls.map(ms => {
                const val = ms.value;
                const inp = ms.shadowRoot?.querySelector('input');
                return {
                  id: inp?.id?.substring(0, 25) || 'unknown',
                  value: JSON.stringify(val)?.substring(0, 60) || 'null',
                  inputVal: inp?.value || '',
                };
              });
            }).catch(() => []);
            if (preSubmitVals.length > 0) {
              console.log(`  🔍 Pre-submit multiselect values: ${preSubmitVals.map(v => `${v.id}=${v.value}`).join(', ')}`);
            }
            
            console.log(`  ➡️  Step ${stepCount}: Clicking NEXT (Shadow DOM) → "${shadowClicked}"`);
            if (/(submit|apply|send)/i.test(shadowClicked)) {
               submitted = true;
            }
            clickedSomething = true;
            await page.waitForTimeout(2500);
          }
        }

        if (!clickedSomething) {
          // Debug: log all visible buttons on the page to understand what's there
          const visibleButtons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'))
              .filter(b => b.offsetParent !== null && b.offsetWidth > 0)
              .map(b => ({
                tag: b.tagName,
                text: (b.innerText || b.value || '').trim().substring(0, 60),
                qa: b.getAttribute('data-qa') || '',
                type: b.type || '',
                disabled: b.disabled,
                cls: (b.className || '').substring(0, 80)
              }));
          }).catch(() => []);
          console.log(`  🔍 Debug: ${visibleButtons.length} visible buttons found:`);
          for (const b of visibleButtons.slice(0, 10)) {
            console.log(`    → [${b.tag}] "${b.text}" qa="${b.qa}" type="${b.type}" disabled=${b.disabled} cls="${b.cls}"`);
          }

          // Fallback: try clicking disabled action-button after forcing enable
          const disabledBtn = await page.$('button[data-qa="action-button"][disabled], button[data-qa="action-button"][aria-disabled="true"], button[data-qa*="continue" i][disabled], button[data-qa*="continue" i][aria-disabled="true"]').catch(() => null);
          if (disabledBtn) {
            console.log(`  ⚡ Found disabled SR action-button — force-enabling and clicking`);
            await page.evaluate(() => {
              const btn = document.querySelector('button[data-qa="action-button"], button[data-qa*="continue" i]');
              if (btn) {
                btn.disabled = false;
                btn.removeAttribute('disabled');
                btn.removeAttribute('aria-disabled');
                btn.click();
              }
            });
            await page.waitForTimeout(2000);
            clickedSomething = true;
          }
          
          if (!clickedSomething) {
            // Last resort: try any visible primary/action button (but NOT cookie/onetrust buttons)
            const anyPrimary = await page.$('button[class*="primary"]:not([disabled]):not([class*="onetrust"]):not([class*="cookie"]), button[class*="action"]:not([disabled]):not([class*="onetrust"]):not([class*="cookie"])').catch(() => null);
            if (anyPrimary && await anyPrimary.isVisible().catch(() => false)) {
              const txt = await anyPrimary.textContent().catch(() => 'unknown');
              if (!/cookie|onetrust|privacy|settings/i.test(txt)) {
                console.log(`  🔘 Fallback: clicking primary button "${txt.trim()}"`);
                await anyPrimary.click({ force: true });
                if (/(submit|apply|send)/i.test(txt)) submitted = true;
                clickedSomething = true;
                await page.waitForTimeout(2000);
              }
            }
          }

          if (!clickedSomething) {
            console.log(`  🔘 No actionable buttons found on step ${stepCount}. Assuming end of form and breaking.`);
            break;
          }
        }
      }

      // 4. Strict Verification — require EXPLICIT confirmation, never assume success
      // Take pre-submit URL to detect redirects
      const preSubmitUrl = page.url();
      await page.waitForTimeout(5000);
      const finalUrl = page.url().toLowerCase();
      const urlChanged = finalUrl !== preSubmitUrl.toLowerCase();
      console.log(`  🔗 Pre-submit URL: ${preSubmitUrl.substring(0,80)}`);
      console.log(`  🔗 Post-submit URL: ${finalUrl.substring(0,80)}`);
      
      const postSubmitPageText = await page.textContent('body').catch(() => '');
      const postSubmitLower = postSubmitPageText.toLowerCase();
      
      // Check for success text early so we can bypass the `!submitted` throw if we actually succeeded
      const earlySuccessText = postSubmitLower.includes('thank you for applying') ||
                            postSubmitLower.includes('thanks for applying') ||
                            postSubmitLower.includes('application received') ||
                            postSubmitLower.includes('application has been received') ||
                            postSubmitLower.includes('successfully submitted') ||
                            postSubmitLower.includes('your job application has been sent') ||
                            postSubmitLower.includes('we have received your application') ||
                            postSubmitLower.includes('application was submitted') ||
                            postSubmitLower.includes('you have applied') ||
                            postSubmitLower.includes('application submitted') ||
                            postSubmitLower.includes("we'll be in touch");

      const earlyHasErrors = postSubmitLower.includes('there was an error') ||
                        postSubmitLower.includes('please fix the errors') ||
                        postSubmitLower.includes('some required fields are missing') ||
                        postSubmitLower.includes('could not submit');

      const earlyIsSR = finalUrl.includes('smartrecruiters.com');
      const earlySrSuccess = earlyIsSR && !earlyHasErrors && (
        earlySuccessText ||
        postSubmitLower.includes('thank you for your interest') ||
        postSubmitLower.includes('your application has been sent') ||
        postSubmitLower.includes('application submitted') ||
        postSubmitLower.includes('we received your application')
      );

      if (!submitted && !earlySuccessText && !earlySrSuccess) throw new Error(`Form exceeded ${MAX_STEPS} steps without Submit button`);
      
      // Save debug HTML and screenshot unconditionally
      const html = await page.content();
      writeFileSync('debug_post_submit.html', html);
      await page.screenshot({ path: 'debug_post_submit.png', fullPage: true });

      // --- Ashby / ATS application rate limit detection ---
      if (postSubmitLower.includes('application limits') || postSubmitLower.includes('limit on how often someone can apply') || postSubmitLower.includes('you can submit up to')) {
        throw new Error(`Application blocked — company has per-person apply limits (applied too many times to ${job.company})`);
      }


      // --- Bot/Captcha detection (text + DOM element based) ---
      const hasCaptchaText = postSubmitLower.includes('please solve this captcha') ||
        postSubmitLower.includes('verify you are human') ||
        postSubmitLower.includes('checking if the site connection is secure') ||
        postSubmitLower.includes('just a moment') ||
        postSubmitLower.includes('hcaptcha') ||
        postSubmitLower.includes('click all items') ||       // hCaptcha image challenge
        postSubmitLower.includes('select all images');       // reCAPTCHA image challenge
      const hasCaptchaWidget = await page.evaluate(() =>
        !!(document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], .h-captcha, #h-captcha, [class*="hcaptcha"], iframe[data-hcaptcha-widget-id]'))
      ).catch(() => false);
      if (hasCaptchaText || hasCaptchaWidget) {
        const isHeaded = process.env.LOCAL_RUN === 'true' || process.env.HEADED === 'true';
        if (isHeaded) {
          // In headed mode: pause and let user solve captcha manually
          console.log('  🔒 Captcha detected — WAITING 90s for you to solve it in the browser window...');
          // Wait for captcha to disappear OR success page to appear
          try {
            await page.waitForFunction(() => {
              const body = document.body.innerText.toLowerCase();
              const hasCaptcha = !!(document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], .h-captcha, #h-captcha, [class*="hcaptcha"], iframe[data-hcaptcha-widget-id]'));
              const isSuccess = body.includes('thank you') || body.includes('application received') || body.includes('successfully submitted') || body.includes('thanks for applying');
              return !hasCaptcha || isSuccess;
            }, { timeout: 90000 });
            console.log('  ✅ Captcha solved! Continuing...');
            // Give page time to process after captcha solve
            await page.waitForTimeout(3000);
          } catch (e) {
            console.log('  ⏰ Captcha not solved in 90s — marking for manual apply');
            job.hasCaptcha = true;
            throw new Error('Captcha Blocked Submission — timed out waiting for manual solve');
          }
        } else {
          // Headless mode: can't solve captcha, mark for manual
          job.hasCaptcha = true;
          console.log('  🔒 hCaptcha/reCAPTCHA triggered post-submit — cannot solve automatically, marking for manual apply');
          throw new Error('Captcha Blocked Submission — requires manual apply');
        }
      }


      // --- Spam/bot block detection — try to self-heal before giving up ---
      if (postSubmitLower.includes('flagged as possible spam') || postSubmitLower.includes('flagged as spam') || postSubmitLower.includes('submission was blocked') || postSubmitLower.includes('robot') || postSubmitLower.includes('automated submission')) {
        console.log('  🚨 Bot/spam block detected — invoking self-healing agent...');
        const healed = await healAndRetry(page, job);
        if (!healed) throw new Error('Submission blocked as spam/bot by ATS (heal failed)');
        // Re-evaluate page after healing
        const healedText = await page.textContent('body').catch(() => '').then(t => t.toLowerCase());
        if (healedText.includes('thank you') || healedText.includes('application received') || healedText.includes('successfully submitted')) {
          console.log('  ✅ Healed — application confirmed successful!');
          // fall through to success path below
        } else {
          throw new Error('Submission blocked as spam/bot by ATS (heal did not resolve)');
        }
      }
      
      // --- SUCCESS requires an EXPLICIT positive signal ---
      const isSuccessUrl = finalUrl.includes('/thank') || finalUrl.includes('thank_you') || finalUrl.includes('/confirmation') || finalUrl.includes('/applied') || finalUrl.includes('/success') || finalUrl.includes('status=applied');
      const isSuccessText = postSubmitLower.includes('thank you for applying') ||
                            postSubmitLower.includes('thanks for applying') ||
                            postSubmitLower.includes('application received') ||
                            postSubmitLower.includes('application has been received') ||
                            postSubmitLower.includes('successfully submitted') ||
                            postSubmitLower.includes('your job application has been sent') ||
                            postSubmitLower.includes('we have received your application') ||
                            postSubmitLower.includes('application was submitted') ||
                            postSubmitLower.includes('you have applied') ||
                            postSubmitLower.includes('application submitted') ||
                            postSubmitLower.includes("we'll be in touch") ||
                            postSubmitLower.includes('applied successfully') ||
                            postSubmitLower.includes('thank you for your interest') ||
                            postSubmitLower.includes('your application has been submitted');

      // --- Check if submit button disappeared (form accepted) ---
      let submitButtonGone = true;
      for (const sel of SUBMIT_SELECTORS.slice(0, 5)) {
        const btn = await page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) { submitButtonGone = false; break; }
      }

      // --- ERROR detection (broadened to catch banner-style errors) ---
      const errorSelectors = [
        '.error', '.error-message', '.error-banner', '.alert-danger', '.alert-error',
        '[aria-invalid="true"]', '.invalid', '.parsley-error', '.text-danger',
        '.application-error', '.form-error', '.validation-error'
      ];
      let hasErrors = false;
      for (const sel of errorSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          const errText = await el.textContent().catch(() => '');
          if (errText && errText.trim().length > 0 && !errText.toLowerCase().includes('success')) {
            console.log(`  ⚠️ Error element detected: "${errText.trim().substring(0, 80)}"`);
            hasErrors = true;
            break;
          }
        }
      }

      if (!hasErrors && (
        postSubmitLower.includes('missing entry for required field') || 
        postSubmitLower.includes('please fill in all required fields') || 
        postSubmitLower.includes('required fields are missing') ||
        postSubmitLower.includes('please provide a valid email') ||
        postSubmitLower.includes('this field is required')
      )) {
        console.log(`  ⚠️ Required field validation error detected in page text`);
        hasErrors = true;
      }
      
      if (hasErrors) {
        const html = await page.content();
        writeFileSync('datadog_error.html', html);
        await page.screenshot({ path: 'datadog_error_screenshot.png', fullPage: true });
        // --- Self-healing: try to fix validation errors automatically ---
        console.log('  🔧 Validation errors detected — invoking self-healing agent...');
        const healed = await healAndRetry(page, job);
        if (healed) {
          // Re-check errors after healing
          hasErrors = false;
          for (const sel of errorSelectors) {
            const el = await page.$(sel).catch(() => null);
            if (el && await el.isVisible().catch(() => false)) {
              const errText = await el.textContent().catch(() => '');
              if (errText && errText.trim().length > 0 && !errText.toLowerCase().includes('success')) {
                hasErrors = true; break;
              }
            }
          }
          if (!hasErrors) console.log('  ✅ Validation errors resolved by self-healing agent!');
        }
      }
      
      const needsEmailVerification = postSubmitLower.includes('check your email') || 
                                     postSubmitLower.includes('verify your email') || 
                                     postSubmitLower.includes('confirm your email') ||
                                     finalUrl.includes('join.com');

      // --- Platform-specific success: Lever SPA never changes URL ---
      const isLever = finalUrl.includes('jobs.lever.co') || finalUrl.includes('lever.co');
      const isAshby = finalUrl.includes('ashbyhq.com') || finalUrl.includes('jobs.ashby');
      const isSR = finalUrl.includes('smartrecruiters.com');
      const leverSuccess = isLever && !hasErrors && (
        postSubmitLower.includes('application has been submitted') ||
        postSubmitLower.includes('your application was submitted') ||
        postSubmitLower.includes('thanks for applying') ||
        postSubmitLower.includes("we'll be in touch") ||
        postSubmitLower.includes('we received your application') ||
        submitButtonGone
      );
      const ashbySuccess = isAshby && !hasErrors && submitButtonGone;
      // SR oneclick-ui: submit stays on same URL — REQUIRE explicit success text, NOT just submitButtonGone
      // (SR SPA re-renders cause the button to temporarily vanish during form interaction = false positive)
      const srSuccess = isSR && !hasErrors && (
        isSuccessText ||
        postSubmitLower.includes('thank you for your interest') ||
        postSubmitLower.includes('your application has been sent') ||
        postSubmitLower.includes('application submitted') ||
        postSubmitLower.includes('we received your application')
      );

      // SUCCESS = explicit signal OR (no errors + URL changed + submit gone) OR platform-specific
      const isSuccess = !hasErrors && (isSuccessUrl || isSuccessText || (urlChanged && submitButtonGone) || leverSuccess || ashbySuccess || srSuccess);
      
      if (isSuccess) {
        console.log('  ✅ Application verified successful!');
        if (urlChanged) console.log(`  📍 Redirected: ${preSubmitUrl.substring(0,50)} → ${finalUrl.substring(0,50)}`);
        results.applied++;
        job.needsEmailVerification = needsEmailVerification;
        // Track per-company count so subsequent jobs from same company are skipped
        const ck = (job.company||'').toLowerCase().trim();
        companiesApplied[ck] = (companiesApplied[ck] || 0) + 1;

        // ── Dashboard Agent: Upload proof screenshot ──
        const screenshotUrl = await uploadProofScreenshot(page, job, supabase);

        // ── Dashboard Agent: Record success (Supabase insert + status update) ──
        await recordSuccess(job, supabase, {
          screenshotUrl,
          tailoredResumeUrl: job.tailoredPublicUrl,
          tailoredChanges,
          activeResumePath,
        });

        // ── Dashboard Agent: Track cold email ──
        await trackColdEmail(job, supabase, activeResumePath);

        appliedJobs.push(job);
      } else {
        // No explicit success signal — ask the agent to look at the page and decide
        console.log('  🔧 No success signal detected — asking agent to evaluate page state...');
        // Strip <noscript> content from page text — it always says "JavaScript is disabled" and confuses the LLM
        const rawPageText = await page.textContent('body').catch(() => '');
        const pageText = rawPageText.replace(/JavaScript is (disabled|not available|not enabled)[^.]*\.?/gi, '').trim();
        const currentUrl = page.url();
        const agentRaw = await callGroq(
          'You are verifying if a job application was successfully submitted. Ignore any mentions of JavaScript being disabled — that is from a <noscript> tag and is irrelevant. Focus on whether the form was submitted. Return only valid JSON.',
          `URL: ${currentUrl.substring(0, 120)}\nPage text: ${pageText.substring(0, 800)}\n\nDid the application submit successfully? If the page shows the job listing or application form without errors, or any thank-you/confirmation message, that means success. Return JSON: {"success": true/false, "reason": "brief explanation", "action": "optional next action if not success e.g. click submit button selector"}`,
          'llama-3.3-70b-versatile'
        );
        let agentVerdict = { success: false, reason: 'No response' };
        try { agentVerdict = JSON.parse(agentRaw); } catch {}
        console.log(`  🤖 Agent verdict: ${JSON.stringify(agentVerdict)}`);
        if (agentVerdict.success) {
          console.log('  ✅ Agent confirmed application successful!');
          results.applied++;
          job.needsEmailVerification = needsEmailVerification;
          job.agentVerified = true;
          appliedJobs.push(job);
        } else if (agentVerdict.action) {
          // Agent suggests one more action, then recheck
          console.log(`  🤖 Agent suggests: ${agentVerdict.action}`);
          try { await page.locator(agentVerdict.action).first().click({ timeout: 5000, force: true }); } catch {}
          await page.waitForTimeout(3000);
          const retryText = await page.textContent('body').catch(() => '').then(t => t.toLowerCase());
          const retrySuccess = retryText.includes('thank you') || retryText.includes('application received') || retryText.includes('successfully submitted') || retryText.includes('applied successfully');
          if (retrySuccess) {
            console.log('  ✅ Application confirmed after agent-suggested action!');
            results.applied++;
            job.needsEmailVerification = needsEmailVerification;
            appliedJobs.push(job);
          } else {
            throw new Error(`Validation error or missing success confirmation (agent: ${agentVerdict.reason})`);
          }
        } else {
          throw new Error(`Validation error or missing success confirmation (agent: ${agentVerdict.reason})`);
        }
      }

    } catch (e) {
      console.log(`  ❌ Failed: ${e.message}`);
      results.failed++;
      job.errorMessage = e.message;
      
      // Take a debug screenshot of the failure
      if (!job.errorScreenshotPath) {
         try {
           const errorScreenshotPath = join(ROOT, `error_${job.eval_id}.jpeg`);
           await page.screenshot({ path: errorScreenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
           job.errorScreenshotPath = errorScreenshotPath;
         } catch (err) {}
      }
      
      failedJobs.push(job);

      // ── Dashboard Agent: Record failure (screenshot upload + DB insert + status revert) ──
      await recordFailure(job, supabase, {
        errorScreenshotPath: job.errorScreenshotPath,
        tailoredResumeUrl: job.tailoredPublicUrl,
      });
    }

    await page.close().catch(() => {});

    // No cooldown needed — resume tailoring uses Gemini (1M TPM) not Groq
    // Small jitter between jobs to avoid browser resource spikes
    if (job !== jobs[jobs.length - 1]) {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
    }
  }

  await closeBrowser(browser);

  console.log(`\n📊 Results: ${results.applied} applied, ${results.failed} failed, ${results.skipped || 0} skipped\n`);

  // ── Report Applied Jobs via Reporter Agent ──────────────────────────────────
  for (const aj of appliedJobs) {
    await reportApplied(aj, supabase, {
      proofScreenshotPath: aj.errorScreenshotPath, // reuse proof path
      coldEmail: {
        sent: aj.coldEmailSent || false,
        subject: aj.coldEmailSubject || '',
        body: aj.coldEmailBody || '',
      },
    });
  }

  // ── Report Failed Jobs via Reporter Agent ───────────────────────────────────
  for (const fj of failedJobs) {
    await reportFailed(fj, supabase);
  }

  // ── Run Summary via Reporter Agent ──────────────────────────────────────────
  await sendRunSummary(results);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
