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
  STATIC_ANSWERS, tryStaticAnswer,
  SUBMIT_SELECTORS, NEXT_SELECTORS, FINAL_PAGE_SIGNALS,
  MAX_JOBS_PER_RUN, MAX_PREFILTER_PER_COMPANY, MAX_PER_COMPANY, MAX_STEPS,
  DISCORD_WEBHOOK, TARGET_KEYWORDS, SKIP_KEYWORDS, PAGE_LOAD_BLOCKED,
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

const RESUME_PATH = RESUME_PATH_CONST;

// sendDiscordEmbed imported from ./agents/reporter.js


// ============================================
// AI FORM FILLER
// ============================================
async function fillDynamicFields(page) {
  const fields = await page.evaluate(() => {
    const results = [];

    // --- Standard inputs ---
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    for (const el of inputs) {
      const name = (el.name || el.id || '').toLowerCase();
      if (['first_name', 'last_name', 'fname', 'lname', 'name'].includes(name) || name.includes('email') || name.includes('phone') || el.type === 'file' || el.type === 'submit') continue;
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
      } else {
        const parent = el.closest('.field, .form-group, div');
        if (parent) labelText = parent.innerText.split('\\n')[0];
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
          isCombobox: isReactSelect
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


  // Filter out GDPR/cookie consent manager fields and phone picker fields
  const cleanedFields = fields.filter(f => {
    const n = (f.name || f.id || '').toLowerCase();
    if (n.startsWith('fc-preference') || n.startsWith('fc-vendor') || n.startsWith('didomi') || n.includes('consent-slider') || n.includes('gvl-vendor')) return false;
    if (n.includes('search_jobs') || n.includes('search_sort') || n.includes('search_location')) return false;
    // Skip IntlTelInput phone country-code picker and any iti-* fields
    if (n.startsWith('iti-') || n.includes('__search-input')) return false;
    return true;
  });

  if (cleanedFields.length === 0) return;

  // Group radio buttons
  const grouped = {};
  for (const f of cleanedFields) {
    if (!grouped[f.name]) grouped[f.name] = { name: f.name, label: f.label, type: f.type, options: [] };
    if (f.options.length > 0) grouped[f.name].options.push(...f.options);
  }


  const questions = Object.values(grouped);
  if (questions.length === 0) return;

  // --- Static pre-fill: answer common fields without AI ---
  const staticAnswers = [];
  const aiQuestions = [];
  for (const q of questions) {
    const staticMatch = tryStaticAnswer(q.label);
    if (staticMatch) {
      staticAnswers.push({ ...q, staticValue: staticMatch.value, staticType: staticMatch.type });
    } else {
      aiQuestions.push(q);
    }
  }

  // Fill static answers immediately (no Groq call)
  // First: blur any focused element (e.g. file upload) to prevent keyboard interference
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }).catch(() => {});
  await page.waitForTimeout(200);

  for (const q of staticAnswers) {
    try {
      const el = await page.$(`[name="${q.name}"], [id="${q.name}"]`);
      if (el) {
        const tag = (await el.evaluate(e => e.tagName)).toLowerCase();
        const cls = (await el.getAttribute('class') || '').toLowerCase();
        const isReactSelectInput = cls.includes('select__input') || cls.includes('select-field__input') || q.isCombobox || q.staticType === 'reactselect';

        if (tag === 'select') {
          await el.selectOption({ label: q.staticValue }).catch(() => el.selectOption(q.staticValue).catch(() => {}));
        } else if (isReactSelectInput) {
          // React Select: must use Playwright pointer events, not el.fill()
          await fillReactSelect(page, el, q.staticValue);
        } else {
          // Keyboard simulation — works on ALL React variants (Ashby, Greenhouse, Lever)
          // Explicitly focus the element before typing to avoid cross-field interference
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(100); // Let page settle before interacting
          await el.focus().catch(() => {});
          await el.click({ clickCount: 3 }).catch(() => {});  // select all + set focus
          await page.waitForTimeout(100);
          // Verify focus is on this element before typing
          const isFocusedStatic = await page.evaluate((el) => document.activeElement === el, el).catch(() => false);
          if (!isFocusedStatic) {
            await el.click({ force: true }).catch(() => {});
            await page.waitForTimeout(100);
          }
          await page.keyboard.type(q.staticValue, { delay: 10 });
          // Wait for typeahead/autocomplete dropdown — Ashby can take up to 900ms
          await page.waitForTimeout(900);
          
          // Multi-strategy suggestion picker (CSS-class-independent):
          // Strategy 1: ARIA role="option" — works on all ATS including future Ashby versions
          // Strategy 2: Ashby obfuscated class (backup for current version)
          // Strategy 3: listbox li items
          // Strategy 4: data-value attribute (some ATSs use this)
          const SUGGESTION_SELECTORS = [
            '[role="option"]',
            '[role="listbox"] li',
            'li[data-value]',
            'div[class*="_option_"]:not([class*="_container_"]):not([class*="_yesno_"])',
            '.autocomplete-suggestion',
            'ul.suggestions li',
          ];
          
          let clicked = false;
          for (const sel of SUGGESTION_SELECTORS) {
            if (clicked) break;
            try {
              const allOptions = await page.$$(sel);
              const visibleOptions = [];
              for (const opt of allOptions) {
                if (await opt.isVisible().catch(() => false)) visibleOptions.push(opt);
              }
              if (visibleOptions.length === 0) continue;
              
              // Prefer an option whose text starts with the typed value (e.g. "Germany")
              let best = null;
              const valLower = q.staticValue.toLowerCase();
              for (const opt of visibleOptions) {
                const txt = (await opt.textContent().catch(() => '')).trim().toLowerCase();
                if (txt.startsWith(valLower) || txt === valLower) { best = opt; break; }
              }
              // Fallback: just pick the first visible option
              if (!best && visibleOptions.length > 0) best = visibleOptions[0];
              
              if (best) {
                await best.scrollIntoViewIfNeeded().catch(() => {});
                await best.click({ force: true }).catch(() => {});
                await page.waitForTimeout(300);
                clicked = true;
              }
            } catch {}
          }
          
          if (!clicked) {
            // No dropdown appeared — press Tab to confirm the typed value
            await page.keyboard.press('Tab');
            await page.waitForTimeout(150);
          }
          // Post-fill verification: if still empty, try el.fill() as fallback
          const verifyVal = await el.inputValue().catch(() => '');
          if (!verifyVal.trim()) {
            await el.fill(q.staticValue).catch(() => {});
            await page.waitForTimeout(200);
          }
        }
        console.log(`    ↳ [cache] Filled ${q.name} -> ${q.staticValue}`);
      }
    } catch {}
  }


  // Post-static re-verify: React re-renders can clear a field when the next field is filled.
  // Run ALWAYS before AI fills AND again after AI fills.
  async function reVerifyStaticFields() {
    await page.waitForTimeout(300);
    for (const q of staticAnswers) {
      try {
        if (q.staticType === 'text' || !q.staticType) {
          const el = await page.$(`[name="${q.name}"], [id="${q.name}"]`);
          if (el) {
            const currentVal = await el.inputValue().catch(() => '');
            if (!currentVal.trim() && q.staticValue) {
              await el.scrollIntoViewIfNeeded().catch(() => {});
              await el.focus().catch(() => {});
              await el.click({ clickCount: 3 }).catch(() => {});
              await page.waitForTimeout(80);
              await page.keyboard.type(q.staticValue, { delay: 10 });
              await page.waitForTimeout(300);
              const afterVal = await el.inputValue().catch(() => '');
              if (!afterVal.trim()) {
                await el.fill(q.staticValue).catch(() => {});
              }
              console.log(`    ↳ [re-fill] Re-filled ${q.name} -> ${q.staticValue}`);
            }
          }
        }
      } catch {}
    }
  }

  // Always run pre-AI re-verify pass
  await reVerifyStaticFields();

  if (aiQuestions.length === 0) {
    console.log(`  ✅ All ${staticAnswers.length} fields filled from cache (0 AI tokens used)`);
    return;
  }

  console.log(`  🤖 AI reading ${aiQuestions.length} custom fields (${staticAnswers.length} pre-filled from cache)...`);

const sysPrompt = `You are an AI filling out a job application. Use the candidate's profile to answer the custom questions.
PROFILE CONTEXT:
${PROFILE_YAML}
Candidate LinkedIn: ${PROFILE.linkedin}
Candidate GitHub: ${PROFILE.github}
Candidate Location: Munich, Germany (EU Blue Card holder, no visa sponsorship needed for EU)

Return JSON strictly in this format:
{"answers": [{"name": "input_name_attribute", "value": "your_answer", "type": "text|select|radio|checkbox|reactselect"}]}

CRITICAL RULES:
- NEVER leave a required field blank. NEVER return an empty string "" as value.
- For any 'text' field with label containing "country" or "residence": ALWAYS return "Germany".
- For 'reactselect' or 'select' type: your 'value' MUST be EXACTLY ONE of the option labels listed in the field's 'options' array. Copy it exactly, character for character.
- For multi-select fields (label contains "location(s)", "select all", "languages you speak"): return comma-separated values BUT limit to AT MOST 2-3 relevant choices. For LOCATION multi-select: prefer "Remote" if listed. Add at most 1 more specific city/country option relevant to Germany.
- For 'radio'/'checkbox': your 'value' must exactly match the option's 'value' field (NOT the label).
- Visa/Sponsorship: Answer "No" or the closest option meaning no sponsorship needed.
- Notice Period: "1 month", "4 weeks", or "Immediate" depending on options.
- Salary: "55000" (or match the format shown in the form).
- Disability/Veteran/Gender: Always "Decline to answer", "Prefer not to say", or "No".
- Yes/No questions: answer "Yes" or "No" exactly unless options are different.
- Certification/consent questions ("I certify...", "I understand...", "I agree..."): answer "Yes".
- LinkedIn/GitHub links: ALWAYS include https://. LinkedIn → ${PROFILE.linkedin}, GitHub → ${PROFILE.github}.
- Location questions: pick "Remote" if available. Otherwise pick the single option closest to Germany/Munich.
- "How did you hear": pick "LinkedIn" or the closest match from the options list.
- DO NOT invent values not in the options list for select/reactselect fields.
- DO NOT use actual newlines inside JSON strings. Use literal \\n if needed.
- Escape double quotes inside answer values with \\"`;

  const userPrompt = `Form Fields (for reactselect/select types, 'options' lists the EXACT values you may choose from):\n` + JSON.stringify(aiQuestions, null, 2);


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
    for (const q of aiQuestions) qLabelMap[q.name] = (q.label || '').toLowerCase();

    // Fix empty AI values using heuristic fallbacks
    for (const ans of data.answers) {
      if (!ans.value || !ans.value.trim()) {
        const label = qLabelMap[ans.name] || '';
        if (/country|reside|passport|nation/i.test(label)) { ans.value = 'Germany'; }
        else if (/github|portfolio/i.test(label)) { ans.value = 'https://github.com/AbhishekAbsy0710'; }
        else if (/linkedin/i.test(label)) { ans.value = 'https://www.linkedin.com/in/abhishek-raj-pagadala'; }
        else if (/twitter|x\.com/i.test(label)) { ans.value = 'https://x.com/AbhishekAbsy'; }
      }
    }

    for (const ans of data.answers) {
      try {
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
          // Try named selector first (3s timeout), then fall back to full-page select scan
          const selectFilled = await page.selectOption(selector, { value: ans.value }, { force: true, timeout: 3000 })
            .catch(() => page.selectOption(selector, { label: ans.value }, { force: true, timeout: 3000 }))
            .catch(() => null);
          if (!selectFilled) {
            // Smarter fallback: scan all visible selects, try exact → partial → EEO-default matching
            const allSels = await page.$$('select');
            const targetLower = (ans.value || '').toLowerCase();
            let filled = false;
            for (const sel of allSels) {
              if (!await sel.isVisible().catch(() => false)) continue;
              // Get all option labels for this select
              const opts = await sel.evaluate(s =>
                Array.from(s.options).map(o => ({ v: o.value, l: o.text.trim() }))
              ).catch(() => []);
              if (!opts.length) continue;
              // 1. Exact label match
              const exact = opts.find(o => o.l.toLowerCase() === targetLower);
              // 2. Partial label match (e.g. "1 month" matches "1 Month Notice")
              const partial = opts.find(o => o.l.toLowerCase().includes(targetLower) || targetLower.includes(o.l.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,5)));
              // 3. EEO / decline default — for gender/veteran/disability/sponsorship fields
              const eeoDefault = opts.find(o => /prefer not|decline|not disclose|i don.t wish/i.test(o.l));
              // 4. "No" default for yes/no selects (visa sponsorship)
              const noOpt = opts.find(o => /^no$/i.test(o.l.trim()));
              const chosen = exact || partial || eeoDefault || noOpt;
              if (chosen) {
                const picked = await sel.selectOption({ value: chosen.v }, { timeout: 1000 }).catch(() => null);
                if (picked) { filled = true; break; }
              }
            }
            if (!filled) console.log(`    ↳ ⚠️ Could not fill select for field: ${ans.name} (value: ${ans.value})`);
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
                // Explicitly focus the element before typing to avoid cross-field interference
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.focus().catch(() => {});
                await el.click({ clickCount: 3 }).catch(() => {});
                await page.waitForTimeout(50);
                const isFocused2 = await page.evaluate((el) => document.activeElement === el, el).catch(() => false);
                if (!isFocused2) await el.focus().catch(() => {});
                await page.keyboard.type(ans.value, { delay: 10 });
                await page.waitForTimeout(100);
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

  // Post-AI re-verify: AI fills may have cleared previously-set static fields
  // (e.g. filling a textarea causes React to reconcile and blank out an earlier text input)
  await reVerifyStaticFields();
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
async function fillBaseFields(page, resumePath) {
  // Prevent links from opening in a new tab so we stay on the same page
  await page.evaluate(() => {
    document.querySelectorAll('a').forEach(a => a.removeAttribute('target'));
  }).catch(() => {});

  // Try to click any initial "Apply" buttons if it's Lever/Generic
  const applyBtns = await page.$$('a:has-text("Apply for this job"), button:has-text("Apply"), a.apply-button, .apply-btn');
  // Name — covers Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, BambooHR, Recruitee, Personio
  await fillField(page, '#first_name, input[name="first_name"], input[name*="first"]:not([name*="preferred"]), input[id*="firstName"], input[data-name*="first"]', PROFILE.firstName);
  await fillField(page, '#last_name, input[name="last_name"], input[name*="last"], input[id*="lastName"], input[data-name*="last"]', PROFILE.lastName);
  await fillField(page, '#preferred_name, input[name="preferred_name"], input[name*="preferred"]', PROFILE.firstName);
  await fillField(page, 'input[name="name"], input[name="cards[0][field0]"]', PROFILE.fullName); // Lever / generic
  await fillField(page, 'input[name="_systemfield_name"]', PROFILE.fullName); // Ashby
  await fillField(page, 'input[name="candidate[first_name]"]', PROFILE.firstName); // Recruitee
  await fillField(page, 'input[name="candidate[last_name]"]', PROFILE.lastName);   // Recruitee
  await fillField(page, 'input[id="candidate_first_name"]', PROFILE.firstName);   // Personio
  await fillField(page, 'input[id="candidate_last_name"]', PROFILE.lastName);     // Personio

  // Email & Phone — expanded for SmartRecruiters, iCIMS, BambooHR
  await fillField(page, '#email, input[name="email"], input[type="email"], input[name="_systemfield_email"], input[id*="email"], input[name="candidate[email]"]', PROFILE.email);
  await fillField(page, '#phone, input[name="phone"], input[type="tel"], input[name="_systemfield_phone"], input[id*="phone"], input[name="candidate[phone]"], input[placeholder*="phone" i]', PROFILE.phone);

  // Address / Location — SmartRecruiters, iCIMS, BambooHR
  await fillField(page, 'input[name*="location"], input[id*="location"], input[placeholder*="City" i], input[name*="city"], input[id*="city"]', PROFILE.city);
  await fillField(page, 'input[name*="country"], input[id*="country"], select[name*="country"]', PROFILE.country || 'Germany');
  await fillField(page, 'input[name*="zip"], input[id*="zip"], input[name*="postal"]', PROFILE.zip || '');

  // Socials
  await fillField(page, 'input[name*="linkedin"], input[id*="linkedin"], input[placeholder*="linkedin" i]', PROFILE.linkedin);
  await fillField(page, 'input[name*="github"], input[id*="github"], input[placeholder*="github" i]', PROFILE.github || '');
  await fillField(page, 'input[name*="website"], input[id*="website"], input[placeholder*="website" i], input[name*="portfolio"]', PROFILE.website || PROFILE.linkedin);

  // Current company / title (iCIMS, BambooHR, SmartRecruiters)
  await fillField(page, 'input[name*="current_company"], input[id*="currentCompany"], input[name*="company"]:not([name*="apply"]):not([name*="hiring"])', PROFILE.currentCompany || '');
  await fillField(page, 'input[name*="current_title"], input[id*="currentTitle"], input[name*="title"]:not([name*="job"])', PROFILE.currentTitle || '');

  // Resume
  if (existsSync(resumePath)) {
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const accept = await input.getAttribute('accept') || '';
        const name = await input.getAttribute('name') || '';
        if (accept.includes('pdf') || name.includes('resume') || name.includes('cv') || name.includes('_systemfield_resume') || fileInputs.length === 1) {
          await input.setInputFiles(resumePath).catch(() => {});
          console.log('  📎 Resume uploaded to an input');
        }
      }
    } catch (e) {}
  }

  // ── Lever EEO / Diversity fields ─────────────────────────────────────────
  // These are optional but required for form submission on many Lever postings.
  // We select "Decline to self-identify" for all demographic dropdowns.
  const eeoSelects = {
    'select[name="eeo[gender]"]':   'Decline to self-identify',
    'select[name="eeo[race]"]':     'Decline to self-identify',
    'select[name="eeo[veteran]"]':  'I decline to self-identify for protected veteran status',
    'select[name="eeo[disability]"]': 'I do not want to answer',
  };
  for (const [sel, val] of Object.entries(eeoSelects)) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.selectOption({ label: val }).catch(async () => {
          // Fallback: pick first non-empty option
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (el && el.options.length > 1) {
              el.selectedIndex = el.options.length - 1; // "Decline" is always last
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, sel);
        });
      }
    } catch {}
  }

  // Disability signature fields (name + date required on many Lever forms)
  await fillField(page, 'input[name="eeo[disabilitySignature]"], input[name="eeo[disabilitySignatureName]"]', PROFILE.fullName);
  try {
    const dateSel = await page.$('input[name="eeo[disabilitySignatureDate]"], input[name="accountId"]');
    if (dateSel && await dateSel.isVisible()) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      await dateSel.fill(today).catch(() => {});
    }
  } catch {}
  // ─────────────────────────────────────────────────────────────────────────
}


async function fillField(page, selector, value) {
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
      return true;
    }
  } catch {}
  return false;
}

// ============================================
// DYNAMIC RESUME TAILORING — APPEND ONLY
// Nothing is replaced. All original content is preserved verbatim.
// Only appends: summary sentences, experience bullets, a Tailored Skills row.
// ============================================
async function generateTailoredResume(job, context, supabase, fallbackPath) {
  const baseJsonPath = join(ROOT, 'resume', 'base-resume.json');
  if (!existsSync(baseJsonPath)) return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };

  console.log(`  🤖 Tailoring resume for ${job.company} - ${job.title}...`);
  const baseJsonStr = readFileSync(baseJsonPath, 'utf8');

  const sysPrompt = `You are an expert technical recruiter. APPEND relevant content to the candidate's resume to maximise ATS match. You are STRICTLY FORBIDDEN from changing, deleting, or rewriting any existing content.

RULES:
- Do NOT modify existing bullets, titles, dates, companies, education, certifications, or contact info.
- Do NOT fabricate experience the candidate does not have.
- Only add content that is a truthful extension of existing experience.

Return ONLY valid JSON with these keys:
{
  "title": "Updated headline matching the job title",
  "summary_append": "1-2 sentences to APPEND (not replace) to the existing summary paragraph, linking candidate's experience to this specific role",
  "experience_append": {
    "CompanyName": ["new bullet to append", "optional second bullet"]
  },
  "new_skills": ["skill1", "skill2"]
}

- "experience_append": only include the 1-2 most relevant companies. Each bullet must be a truthful, specific extension of work already described (e.g. if Terraform is listed, add a JD-relevant Terraform bullet).
- "new_skills": 3-8 keywords from the JD the candidate realistically has.
- Return ONLY JSON — no explanation.`;

  const userPrompt = `Job Title: ${job.title}\nCompany: ${job.company}\nJob Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nCandidate Base Resume JSON:\n${baseJsonStr}`;

  // Deep-clone base so original is never mutated
  let tailoredJson = JSON.parse(baseJsonStr);
  let changesMadeArr = [];

  // Resume tailoring: try Groq first (free, avoids Gemini 429 quota), fallback to Gemini
  const tailorCall = (sys, usr) => callGroq(sys, usr);
  const tailorCallFallback = process.env.GEMINI_API_KEY
    ? (sys, usr) => callGemini(sys, usr)
    : null;

  try {
    console.log(`  🔄 Generating append-only tailored content (Groq)...`);
    let res = await tailorCall(sysPrompt, userPrompt);
    // If Groq fails (returns '{}'), try Gemini fallback
    if ((!res || res.trim() === '{}') && tailorCallFallback) {
      console.log(`  🔄 Groq returned empty — retrying with Gemini...`);
      res = await tailorCallFallback(sysPrompt, userPrompt);
    }
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');

    const patch = JSON.parse(match[0]);
    if (Object.keys(patch).length === 0) throw new Error('AI returned empty JSON');

    // 1. Headline — update only (visual, not core data)
    if (patch.title && patch.title !== tailoredJson.personal.title) {
      tailoredJson.personal.title = patch.title;
      changesMadeArr.push(`Headline → "${patch.title}"`);
    }

    // 2. Summary — APPEND sentences, never replace
    if (patch.summary_append && patch.summary_append.trim()) {
      const append = patch.summary_append.trim();
      // Avoid duplicating if already appended (idempotent)
      if (!tailoredJson.summary.includes(append.substring(0, 30))) {
        tailoredJson.summary = tailoredJson.summary.trimEnd() + ' ' + append;
        changesMadeArr.push('Appended to summary');
      }
    }

    // 3. Experience — APPEND bullets, never replace or reorder
    if (patch.experience_append && typeof patch.experience_append === 'object') {
      for (const [company, newBullets] of Object.entries(patch.experience_append)) {
        if (!Array.isArray(newBullets) || newBullets.length === 0) continue;
        const expEntry = tailoredJson.experience.find(
          e => e.company.toLowerCase().includes(company.toLowerCase()) ||
               company.toLowerCase().includes(e.company.toLowerCase())
        );
        if (!expEntry) continue;
        const added = [];
        for (const bullet of newBullets) {
          const b = bullet.trim();
          if (!b) continue;
          // Don't add if semantically already covered (simple dedup)
          const alreadyExists = expEntry.bullets.some(
            existing => existing.toLowerCase().includes(b.substring(0, 25).toLowerCase())
          );
          if (!alreadyExists) {
            expEntry.bullets.push(b);
            added.push(b.substring(0, 50));
          }
        }
        if (added.length > 0) changesMadeArr.push(`+${added.length} bullet(s) @ ${expEntry.company}`);
      }
    }

    // 4. Skills — APPEND a new "Tailored Skills" row, never modify existing rows
    if (patch.new_skills && Array.isArray(patch.new_skills) && patch.new_skills.length > 0) {
      tailoredJson.skills['Tailored for Role'] = patch.new_skills.join(', ');
      changesMadeArr.push(`+${patch.new_skills.length} tailored skill keywords`);
    }

    tailoredJson.changes_made = changesMadeArr.length > 0
      ? changesMadeArr.join(' | ')
      : 'Base Resume (No modifications)';

    if (changesMadeArr.length === 0) throw new Error('No meaningful changes made');

    // 5. ATS score
    console.log(`  📊 Evaluating tailored resume (Gemini)...`);
    const scoreRes = process.env.GEMINI_API_KEY
      ? await callGemini(
          'You are a strict ATS. Compare resume to JD. Return JSON: {"score": integer 0-100}',
          `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume:\n${JSON.stringify(tailoredJson)}`
        )
      : await callGroq(
          'You are a strict ATS. Compare resume to JD. Return JSON: {"score": integer 0-100}',
          `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume:\n${JSON.stringify(tailoredJson)}`,
          'llama-3.1-8b-instant'
        );
    let score = 0;
    try {
      const sm = scoreRes.match(/\{[\s\S]*\}/);
      if (sm) score = JSON.parse(sm[0]).score || 0;
    } catch { score = parseInt(scoreRes.replace(/\D/g, '')) || 0; }
    console.log(`  📈 ATS Score: ${score}%`);

  } catch(e) {
    console.log(`  ⚠️ Tailoring failed (${e.message}), using base resume.`);
    return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };
  }

  // Build PDF from tailored JSON
  const templateStr = readFileSync(join(ROOT, 'src', 'scripts', 'resume-template.html'), 'utf8');

  const skillsHtml = Object.entries(tailoredJson.skills || {}).map(([cat, sk]) =>
    `<div class="skill-category">${cat}</div><div>${sk}</div>`
  ).join('');

  const expHtml = (tailoredJson.experience || []).map(exp => `
    <div class="experience-item">
      <div class="exp-header">
        <div><span class="exp-title">${exp.role}</span> | <span class="exp-company">${exp.company}</span></div>
        <div class="exp-date-loc">${exp.date} • ${exp.location || ''}</div>
      </div>
      <ul>${(exp.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul>
    </div>
  `).join('');

  const eduHtml = (tailoredJson.education || []).map(edu => `
    <div class="edu-item">
      <div><span class="edu-degree">${edu.degree}</span>, <span class="edu-school">${edu.school}</span></div>
      <div class="exp-date-loc">${edu.date} • ${edu.location || ''}</div>
    </div>
  `).join('');

  const certsHtml = (tailoredJson.certifications || []).map(c => `<div class="cert-item">${c}</div>`).join('');

  const finalHtml = templateStr
    .replace('{{name}}', tailoredJson.personal?.name || '')
    .replace('{{title}}', tailoredJson.personal?.title || '')
    .replace('{{location}}', tailoredJson.personal?.location || '')
    .replace(/{{email}}/g, tailoredJson.personal?.email || '')
    .replace('{{phone}}', tailoredJson.personal?.phone || '')
    .replace('{{linkedin}}', tailoredJson.personal?.linkedin || '')
    .replace('{{github}}', tailoredJson.personal?.github || '')
    .replace('{{summary}}', tailoredJson.summary || '')
    .replace('{{skills_html}}', skillsHtml)
    .replace('{{experience_html}}', expHtml)
    .replace('{{education_html}}', eduHtml)
    .replace('{{certifications_html}}', certsHtml);

  const outputPath = join(ROOT, 'resume', `tailored_${job.id}.pdf`);
  const pdfPage = await context.newPage();
  await pdfPage.setContent(finalHtml, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: outputPath, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  await pdfPage.close();

  let publicUrl = null;
  try {
    const pdfBuffer = readFileSync(outputPath);
    const fileName = `resume_${job.id}_${Date.now()}.pdf`;
    await supabase.storage.from('screenshots').upload(fileName, pdfBuffer, { upsert: true, contentType: 'application/pdf' });
    publicUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
    console.log(`  📎 Tailored resume generated & uploaded`);
  } catch(e) {
    console.error('  ⚠️ Failed to upload tailored resume:', e.message);
  }


  return { pdfPath: outputPath, publicUrl, changes: tailoredJson.changes_made || 'Tailored' };
}

// ============================================
// MAIN
// ============================================
async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // Fetch jobs from auto_queue — 30-day window to include full backlog
  // (3-day window was excluding ALL existing Anthropic/Grafana/xAI jobs)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const isLocal = process.env.LOCAL_RUN === 'true';
  let query = supabase
    .from('jobs')
    .select('*, evaluations(id, letter_grade, weighted_score)')
    .eq('status', 'auto_queue')
    .gte('scraped_at', thirtyDaysAgo);
  // On GHA exclude Greenhouse (Cloudflare blocks datacenter IPs)
  // On local Mac (LOCAL_RUN=true), include Greenhouse — home IP not blocked
  if (!isLocal) query = query.not('apply_link', 'ilike', '%greenhouse%');
  query = query.order('scraped_at', { ascending: false }).limit(200);

  // TEST MODE: restrict to a single job ID for safe testing
  if (process.env.TEST_JOB_ID) {
    console.log(`🧪 TEST MODE — running only job ID ${process.env.TEST_JOB_ID}`);
    query = supabase
      .from('jobs')
      .select('*, evaluations(id, letter_grade, weighted_score)')
      .eq('id', process.env.TEST_JOB_ID);
  }

  const { data: rawJobs, error } = await query;

  if (error || !rawJobs || rawJobs.length === 0) {
    console.log('💭 No jobs in the apply queue (all caught up)');
    return;
  }

  let jobs = rawJobs.map(j => {
    const e = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
    return { ...j, eval_id: e?.id, grade: e?.letter_grade, score: e?.weighted_score || 0 };
  }).sort((a, b) => (b.score || 0) - (a.score || 0)); // best-scored first

  // MAX_JOBS_PER_RUN, MAX_PREFILTER_PER_COMPANY, PAGE_LOAD_BLOCKED imported from agents/constants.js

  // GREENHOUSE FILTER: job-boards.greenhouse.io is blocked by Cloudflare on GHA runner IPs.
  // Skip on LOCAL_RUN=true (Mac) — home IP is not on Cloudflare blocklist.
  if (!isLocal) {
    const greenhouseJobs = jobs.filter(j => (j.apply_link || '').includes('greenhouse'));
    if (greenhouseJobs.length > 0) {
      console.log(`  ⚠️  Skipping ${greenhouseJobs.length} Greenhouse jobs (Cloudflare blocks GHA IPs) — moved to manual_queue`);
      for (const gj of greenhouseJobs) {
        await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', gj.id).catch(() => {});
      }
    }
    jobs = jobs.filter(j => !(j.apply_link || '').includes('greenhouse'));
  } else {
    console.log(`  🏠 LOCAL_RUN mode — Greenhouse jobs INCLUDED (home IP not blocked)`);
  }

  // Pre-filter: cap per company so one company can't dominate the 25-slot batch
  const prefilterCounts = {};
  jobs = jobs.filter(j => {
    const key = (j.company || '').toLowerCase().replace(/[^a-z]/g, '');
    prefilterCounts[key] = (prefilterCounts[key] || 0) + 1;
    return prefilterCounts[key] <= MAX_PREFILTER_PER_COMPANY;
  });

  if (jobs.length > MAX_JOBS_PER_RUN) {
    console.log(`  📊 ${jobs.length} jobs queued (after company cap) — capping to top ${MAX_JOBS_PER_RUN} by score`);
    jobs = jobs.slice(0, MAX_JOBS_PER_RUN);
  } else {
    console.log(`  📊 ${jobs.length} jobs queued (max ${MAX_PREFILTER_PER_COMPANY}/company diversity applied)`);
  }

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
      // Per-company rate limit gate — skip if already applied to this company MAX_PER_COMPANY times
      const companyKey = (job.company || '').toLowerCase().trim();
      if (companiesApplied[companyKey] >= MAX_PER_COMPANY) {
        console.log(`  ⏭️ Skipping — already applied to ${job.company} ${companiesApplied[companyKey]}x this run (limit: ${MAX_PER_COMPANY})`);
        results.skipped++;
        await page.close().catch(() => {});
        continue;
      }

      // Pre-filter: hard-skip non-IT roles to save API tokens
      const titleLower = (job.title || '').toLowerCase();
      const isExcluded = SKIP_KEYWORDS.some(kw => titleLower.includes(kw));
      if (isExcluded) {
        console.log(`  ⏭️ Skipping (blocked keyword): "${job.title}"`);
        results.skipped++;
        await page.close().catch(() => {});
        await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id);
        continue;
      }

      const IT_ARCHETYPES = ['devops', 'cloud', 'data', 'ai', 'fullstack', 'DevOps', 'Cloud', 'Data', 'AI', 'FullStack'];
      const isRelevant = TARGET_KEYWORDS.some(kw => titleLower.includes(kw))
                      || IT_ARCHETYPES.includes(job.archetype);
      if (!isRelevant) {
        console.log(`  ⏭️ Skipping (no IT keyword match): "${job.title}"`);
        results.skipped++;
        await page.close().catch(() => {});
        await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id);
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
            await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id).catch(() => {});
            throw new Error('ArbeitNow resolved to Greenhouse (Cloudflare blocks GHA IPs) — manual_queue');
          }
          // Guard: if resolved to Lever or Ashby, move to manual_queue (hCaptcha on submit)
          if (realApplyUrl.includes('lever.co') || realApplyUrl.includes('jobs.lever.co')) {
            console.log(`  ⚠️  ArbeitNow resolved to Lever (hCaptcha) — moving to manual_queue`);
            await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id).catch(() => {});
            throw new Error('ArbeitNow resolved to Lever (hCaptcha blocks submission) — manual_queue');
          }
          if (realApplyUrl.includes('ashbyhq.com')) {
            console.log(`  ⚠️  ArbeitNow resolved to Ashby (hCaptcha) — moving to manual_queue`);
            await supabase.from('jobs').update({ status: 'manual_queue', apply_link: realApplyUrl }).eq('id', job.id).catch(() => {});
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
            'llama-3.1-8b-instant'  // Use 8b model — 500k TPD vs 100k for 70b
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
            await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id).catch(() => {});
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


      // Early captcha/bot detection — skip immediately (text + DOM)
      const preHasCaptchaWidget = await page.evaluate(() =>
        !!(document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], .h-captcha, #h-captcha, [class*="hcaptcha"]'))
      ).catch(() => false);
      if (pageLower.includes('please solve this captcha') || pageLower.includes('verify you are human') ||
          pageLower.includes('checking if the site connection is secure') || pageLower.includes('just a moment') ||
          pageLower.includes('enable javascript and cookies') || preHasCaptchaWidget) {
        throw new Error('Captcha/bot detection on page load — marking for manual apply');
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
        //          3) Wait for SR SPA to render the application form

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

        // Step 3: Wait for SR SPA to render — it's React-based and needs time
        console.log(`  ⏳ Waiting for SR application form to render...`);
        await page.waitForTimeout(5000);
        
        // Step 4: Check if any form elements appeared
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
          // Extra wait for slow SPA rendering
          console.log(`  ⏳ No form elements found — waiting 8s more for SPA...`);
          await page.waitForTimeout(8000);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────────────────

      // SUBMIT_SELECTORS, NEXT_SELECTORS, FINAL_PAGE_SIGNALS, MAX_STEPS
      // imported from agents/constants.js — single source of truth
      let submitted = false;
      let stepCount = 0;

      while (!submitted && stepCount < MAX_STEPS) {
        stepCount++;
        console.log(`  📄 Form step ${stepCount}/${MAX_STEPS}...`);

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

        // Re-fill fields on every new step (each step = new DOM)
        await fillBaseFields(page, activeResumePath);
        await fillDemographicFields(page);
        await fillDynamicFields(page);
        await page.waitForTimeout(800);

        // ── SR/Generic consent checkboxes: check ALL visible unchecked checkboxes ──
        // SmartRecruiters has its own data consent checkboxes (separate from OneTrust)
        // that must be checked before the Continue/action-button becomes enabled
        const uncheckedBoxes = await page.$$('input[type="checkbox"]:not(:checked)').catch(() => []);
        for (const cb of uncheckedBoxes) {
          try {
            if (!await cb.isVisible().catch(() => false)) continue;
            // Skip OneTrust checkboxes
            const cbId = await cb.getAttribute('id') || '';
            const cbName = await cb.getAttribute('name') || '';
            if (cbId.includes('onetrust') || cbName.includes('onetrust') || cbId.includes('ot-group-id')) continue;
            // Check consent/privacy/terms checkboxes
            const parentText = await cb.evaluate(el => {
              const parent = el.closest('label, div, span');
              return parent ? (parent.innerText || '').substring(0, 200) : '';
            }).catch(() => '');
            const parentLower = parentText.toLowerCase();
            const isConsent = parentLower.includes('consent') || parentLower.includes('agree') || 
                             parentLower.includes('privacy') || parentLower.includes('terms') ||
                             parentLower.includes('data') || parentLower.includes('accept') ||
                             parentLower.includes('acknowledge') || parentLower.includes('confirm') ||
                             parentLower.includes('datenschutz') || parentLower.includes('einwillig');
            if (isConsent || uncheckedBoxes.length <= 3) {
              // For consent steps with few checkboxes, check them all
              await cb.scrollIntoViewIfNeeded().catch(() => {});
              await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
              console.log(`    ☑️ Checked consent: "${parentText.substring(0, 60)}"`);
              await page.waitForTimeout(300);
            }
          } catch {}
        }
        await page.waitForTimeout(500);

        // Check if this is a review/summary step
        const stepBodyText = await page.textContent('body').catch(() => '');
        const isReviewStep = FINAL_PAGE_SIGNALS.some(s => stepBodyText.toLowerCase().includes(s));

        // Try Submit first (always highest priority)
        let clickedSomething = false;
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
                  try { await supabase.from('jobs').update({ status: 'security_required', notes: 'Email verification required' }).eq('id', job.id); } catch(e) {}
                  try { await supabase.from('applications').insert({ job_id: job.id, eval_id: job.eval_id, status: 'security_required', notes: 'Paused: email verification code needed' }); } catch(e) {}
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
            await btn.click();
            clickedSomething = true;
            await page.waitForTimeout(2500);
            break;
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
          const disabledBtn = await page.$('button[data-qa="action-button"][disabled], button[data-qa="action-button"][aria-disabled="true"]').catch(() => null);
          if (disabledBtn) {
            console.log(`  ⚡ Found disabled SR action-button — force-enabling and clicking`);
            await page.evaluate(() => {
              const btn = document.querySelector('button[data-qa="action-button"]');
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
            // Last resort: try any visible primary/action button
            const anyPrimary = await page.$('button[class*="primary"]:not([disabled]), button[class*="action"]:not([disabled])').catch(() => null);
            if (anyPrimary && await anyPrimary.isVisible().catch(() => false)) {
              const txt = await anyPrimary.textContent().catch(() => 'unknown');
              console.log(`  🔘 Fallback: clicking primary button "${txt.trim()}"`);
              await anyPrimary.click({ force: true });
              clickedSomething = true;
              await page.waitForTimeout(2000);
            }
          }

          if (!clickedSomething) {
            throw new Error(`No Submit or Next button found on step ${stepCount}`);
          }
        }
      }

      if (!submitted) throw new Error(`Form exceeded ${MAX_STEPS} steps without Submit button`);


      // 4. Strict Verification — require EXPLICIT confirmation, never assume success
      // Take pre-submit URL to detect redirects
      const preSubmitUrl = page.url();
      await page.waitForTimeout(5000);
      const url = page.url().toLowerCase();
      const urlChanged = url !== preSubmitUrl.toLowerCase();
      console.log(`  🔗 Pre-submit URL: ${preSubmitUrl.substring(0,80)}`);
      console.log(`  🔗 Post-submit URL: ${url.substring(0,80)}`);
      
      const postSubmitPageText = await page.textContent('body').catch(() => '');
      const postSubmitLower = postSubmitPageText.toLowerCase();
      
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
        job.hasCaptcha = true;
        console.log('  🔒 hCaptcha/reCAPTCHA triggered post-submit — cannot solve automatically, marking for manual apply');
        throw new Error('Captcha Blocked Submission — requires manual apply');
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
      const isSuccessUrl = url.includes('/thank') || url.includes('thank_you') || url.includes('/confirmation') || url.includes('/applied') || url.includes('/success') || url.includes('status=applied');
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

      // Also check for error-like text in page body — only specific ATS error patterns
      // NOTE: Do NOT check 'this field is required' — it appears in Datadog field descriptions always
      if (!hasErrors && (postSubmitLower.includes('missing entry for required field') || postSubmitLower.includes('please fill in all required fields') || postSubmitLower.includes('required fields are missing'))) {
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
                                     url.includes('join.com');

      // --- Platform-specific success: Lever SPA never changes URL ---
      const isLever = url.includes('jobs.lever.co') || url.includes('lever.co');
      const isAshby = url.includes('ashbyhq.com') || url.includes('jobs.ashby');
      const isSR = url.includes('smartrecruiters.com');
      const leverSuccess = isLever && !hasErrors && (
        postSubmitLower.includes('application has been submitted') ||
        postSubmitLower.includes('your application was submitted') ||
        postSubmitLower.includes('thanks for applying') ||
        postSubmitLower.includes("we'll be in touch") ||
        postSubmitLower.includes('we received your application') ||
        submitButtonGone
      );
      const ashbySuccess = isAshby && !hasErrors && submitButtonGone;
      // SR oneclick-ui: submit stays on same URL (case may change), may show thank-you or the form just closes
      const srSuccess = isSR && !hasErrors && (
        isSuccessText ||
        postSubmitLower.includes('thank you for your interest') ||
        postSubmitLower.includes('your application has been sent') ||
        postSubmitLower.includes('application submitted') ||
        postSubmitLower.includes('we received your application') ||
        submitButtonGone
      );

      // SUCCESS = explicit signal OR (no errors + URL changed + submit gone) OR platform-specific
      const isSuccess = !hasErrors && (isSuccessUrl || isSuccessText || (urlChanged && submitButtonGone) || leverSuccess || ashbySuccess || srSuccess);
      
      if (isSuccess) {
        console.log('  ✅ Application verified successful!');
        if (urlChanged) console.log(`  📍 Redirected: ${preSubmitUrl.substring(0,50)} → ${url.substring(0,50)}`);
        results.applied++;
        job.needsEmailVerification = needsEmailVerification;
        // Track per-company count so subsequent jobs from same company are skipped
        const ck = (job.company||'').toLowerCase().trim();
        companiesApplied[ck] = (companiesApplied[ck] || 0) + 1;
        // 5. Insert Application and Take Screenshot Proof
        let methodCol = 'auto';
        if (tailoredChanges !== 'Base Resume (No modifications)') {
           methodCol = 'auto | ' + tailoredChanges.substring(0, 100);
        }

        // Upload proof screenshot — use job.id as fallback if eval_id is null
        let screenshotUrl = null;
        try {
          const proofId = job.eval_id || job.id;
          const screenshotPath = join(ROOT, `proof_${proofId}_${Date.now()}.jpeg`);
          await page.screenshot({ path: screenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
          const screenshotBuffer = readFileSync(screenshotPath);
          const proofFileName = `proof_${proofId}_${Date.now()}.jpeg`;
          await supabase.storage.from('screenshots').upload(proofFileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
          screenshotUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${proofFileName}`;
          console.log(`  📸 Proof screenshot uploaded: ${proofFileName}`);
        } catch (ssErr) {
          console.log(`  ⚠️ Failed to upload proof screenshot: ${ssErr.message}`);
        }

        const { data: appData } = await supabase.from('applications').insert({
          evaluation_id: job.eval_id,
          method: methodCol,
          status: 'submitted',
          pdf_path: tailoredInfo.publicUrl || RESUME_PATH,
          screenshot_url: screenshotUrl,
          applied_at: new Date().toISOString()
        }).select('id').single();

        if (appData) {
          job.app_id = appData.id;
          job.screenshotUrl = screenshotUrl;
        }
        job.resumeUsed = basename(activeResumePath || RESUME_PATH);
        // Save proof URL, resume URL, and timestamp directly into jobs row for easy dashboard display
        try {
          const { error: upErr } = await supabase.from('jobs').update({
            status: 'applied',
            proof_url: screenshotUrl || null,
            tailored_resume_url: tailoredInfo.publicUrl || null,
            applied_at: new Date().toISOString(),
          }).eq('id', job.id);
          if (upErr) {
            // Fallback: columns may not exist yet — just update status
            await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id);
          }
        } catch (upCatchErr) {
          try { await supabase.from('jobs').update({ status: 'applied' }).eq('id', job.id); } catch(e) {}
        }
        
        // 6. Send Cold Email and track result for Discord
        try {
          const { sendColdEmail } = await import('../services/cold-email.js');
          // Use readable YAML profile instead of raw PDF bytes which breaks Groq!
          const cvText = PROFILE_YAML; 
          const emailResult = await sendColdEmail(job, null, cvText, activeResumePath);
          
          if (emailResult && emailResult.target) {
            job.coldEmailSent = true;
            job.coldEmailTarget = emailResult.target;
            job.coldEmailSubject = emailResult.subject;
            job.coldEmailBody = emailResult.body;
          } else {
            job.coldEmailSent = false;
            job.coldEmailError = 'AI generation failed or target blocked';
          }
        } catch (emailErr) {
          console.log(`  ⚠️ Cold email failed: ${emailErr.message}`);
          job.coldEmailSent = false;
          job.coldEmailError = emailErr.message;
        }

        // Save cold email result to the applications record via method field extension
        // Format: "auto | tailoring changes ||| cold_email:{status}:{target}:{subject}"
        try {
          const coldStr = job.coldEmailSent
            ? `COLD_EMAIL_SENT:${job.coldEmailTarget || ''}:${(job.coldEmailSubject||'').substring(0,80)}`
            : `COLD_EMAIL_SKIP:${(job.coldEmailError||'not sent').substring(0,80)}`;
          await supabase.from('applications')
            .update({ method: `${(await supabase.from('applications').select('method').eq('id', job.latestAppId||0).single())?.data?.method || 'auto'} ||| ${coldStr}` })
            .eq('evaluation_id', job.eval_id);
        } catch {}

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
           
           // DEBUG: Dump HTML to see what text caused the validation error
           const htmlDumpPath = join(ROOT, `error_${job.eval_id}.html`);
           const html = await page.content();
           writeFileSync(htmlDumpPath, html);
         } catch (err) {}
      }
      
      failedJobs.push(job);
      // Revert to manual_queue
      await supabase.from('jobs').update({ status: 'manual_queue' }).eq('id', job.id);
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
