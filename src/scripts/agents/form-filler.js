/**
 * agents/form-filler.js — Form Field Filling Agent
 * 
 * ⚠️  DEPRECATED: This file is NOT imported by browser-apply.js.
 * The main loop uses its own inline copy of fillDynamicFields (with Shadow DOM support).
 * This file is kept for reference only. Do NOT add new features here.
 * All form-filling logic should be modified in browser-apply.js directly.
 * 
 * Handles all form field detection and filling:
 * - fillBaseFields: name, email, phone, resume upload, socials, EEO
 * - fillDynamicFields: AI-powered custom field filling (with static cache)
 * - fillDemographicFields: dropdowns for gender, veteran, disability
 * - fillReactSelect: React Select v2 dropdown filling
 * - fillField: Low-level field filling with React compatibility
 * 
 * Exports:
 *   - fillAllFields(page, resumePath) — fill base + demographic + dynamic
 *   - fillBaseFields(page, resumePath)
 *   - fillDemographicFields(page)
 *   - fillDynamicFields(page)
 *   - fillField(page, selector, value)
 */

import { existsSync } from 'fs';
import { callGroq } from './llm-client.js';
import { PROFILE, STATIC_ANSWERS, PROFILE_YAML } from './constants.js';

// ── CSS.escape for Node.js ──────────────────────────────────────────────────
function cssEscape(s) {
  return String(s).replace(/([^\w-])/g, '\\$1');
}

// ── Static Answer Cache ──────────────────────────────────────────────────────
function tryStaticAnswer(label) {
  // Static filling disabled as per user request (relying on LLM)
  return null;
}

// ── Fill a single field (React-compatible) ──────────────────────────────────
export async function fillField(page, selector, value) {
  try {
    const field = await page.$(selector);
    if (field && await field.isVisible()) {
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.click();
      await field.fill('');
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.focus().catch(() => {});
      await field.click({ clickCount: 3 }).catch(() => {});
      await page.waitForTimeout(50);
      const isFocused = await page.evaluate((el) => document.activeElement === el, field).catch(() => false);
      if (!isFocused) await field.focus().catch(() => {});
      await page.keyboard.type(value, { delay: 10 });
      await page.waitForTimeout(80);
      return true;
    }
  } catch {}
  return false;
}

// ── Pick Select Option ──────────────────────────────────────────────────────
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

// ── Fill React Select ──────────────────────────────────────────────────────
async function fillReactSelect(page, inputElement, desiredValue) {
  try {
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

    async function openDropdown() {
      const ctrl = await getControl();
      if (ctrl) {
        await ctrl.click({ force: true }).catch(() => {});
      } else {
        await inputElement.click({ force: true }).catch(() => {});
      }
      await page.waitForTimeout(700);
    }

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
      await openDropdown();
      let initialOpts = await readOptions();
      if (initialOpts.length === 0) {
        await inputElement.focus().catch(() => {});
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);
      }
      await inputElement.fill('').catch(() => {});
      const typeStr = val.substring(0, Math.min(5, val.length));
      await inputElement.type(typeStr, { delay: 80 }).catch(() => {});
      await page.waitForTimeout(800);
      const clicked = await clickBestOption(val);
      if (!clicked) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
        await openDropdown();
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }
      if (i < valuesToSelect.length - 1) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  } catch (e) {
    console.log('    ↳ (React Select error: ' + e.message.split('\n')[0] + ')');
  }
}

// ── Fill Base Fields ──────────────────────────────────────────────────────────
export async function fillBaseFields(page, resumePath) {
  await page.evaluate(() => {
    document.querySelectorAll('a').forEach(a => a.removeAttribute('target'));
  }).catch(() => {});

  // Name
  await fillField(page, '#first_name, input[name="first_name"], input[name*="first"]:not([name*="preferred"]), input[id*="firstName"], input[data-name*="first"]', PROFILE.firstName);
  await fillField(page, '#last_name, input[name="last_name"], input[name*="last"], input[id*="lastName"], input[data-name*="last"]', PROFILE.lastName);
  await fillField(page, '#preferred_name, input[name="preferred_name"], input[name*="preferred"]', PROFILE.firstName);
  await fillField(page, 'input[name="name"], input[name="cards[0][field0]"]', PROFILE.fullName);
  await fillField(page, 'input[name="_systemfield_name"]', PROFILE.fullName);
  await fillField(page, 'input[name="candidate[first_name]"]', PROFILE.firstName);
  await fillField(page, 'input[name="candidate[last_name]"]', PROFILE.lastName);
  await fillField(page, 'input[id="candidate_first_name"]', PROFILE.firstName);
  await fillField(page, 'input[id="candidate_last_name"]', PROFILE.lastName);

  // Email & Phone
  await fillField(page, '#email, input[name="email"], input[type="email"], input[name="_systemfield_email"], input[id*="email"], input[name="candidate[email]"]', PROFILE.email);
  await fillField(page, '#phone, input[name="phone"], input[type="tel"], input[name="_systemfield_phone"], input[id*="phone"], input[name="candidate[phone]"], input[placeholder*="phone" i]', PROFILE.phone);

  // Address / Location
  await fillField(page, 'input[name*="location"], input[id*="location"], input[placeholder*="City" i], input[name*="city"], input[id*="city"]', PROFILE.city);
  await fillField(page, 'input[name*="country"], input[id*="country"], select[name*="country"]', PROFILE.country || 'Germany');
  await fillField(page, 'input[name*="zip"], input[id*="zip"], input[name*="postal"]', PROFILE.zip || '');

  // Socials
  await fillField(page, 'input[name*="linkedin"], input[id*="linkedin"], input[placeholder*="linkedin" i]', PROFILE.linkedin);
  await fillField(page, 'input[name*="github"], input[id*="github"], input[placeholder*="github" i]', PROFILE.github || '');
  await fillField(page, 'input[name*="website"], input[id*="website"], input[placeholder*="website" i], input[name*="portfolio"]', PROFILE.website || PROFILE.linkedin);

  // Current company / title
  await fillField(page, 'input[name*="current_company"], input[id*="currentCompany"], input[name*="company"]:not([name*="apply"]):not([name*="hiring"])', PROFILE.currentCompany || '');
  await fillField(page, 'input[name*="current_title"], input[id*="currentTitle"], input[name*="title"]:not([name*="job"])', PROFILE.currentTitle || '');

  // Resume upload
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
    } catch {}
  }

  // Lever EEO / Diversity
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
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (el && el.options.length > 1) {
              el.selectedIndex = el.options.length - 1;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, sel);
        });
      }
    } catch {}
  }

  // Disability signature
  await fillField(page, 'input[name="eeo[disabilitySignature]"], input[name="eeo[disabilitySignatureName]"]', PROFILE.fullName);
  try {
    const dateSel = await page.$('input[name="eeo[disabilitySignatureDate]"], input[name="accountId"]');
    if (dateSel && await dateSel.isVisible()) {
      const today = new Date().toISOString().split('T')[0];
      await dateSel.fill(today).catch(() => {});
    }
  } catch {}
}

// ── Fill Demographic Fields ──────────────────────────────────────────────────
export async function fillDemographicFields(page) {
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
        await pickSelectOption(page, el, ['Immediately','2 weeks','1 month','Immediate','Less than 1 month','< 1 month','Two weeks']);
      } else if (/visa|sponsorship|workauth/.test(key)) {
        await pickSelectOption(page, el, ['No','Not required','I do not require sponsorship','No, I do not need sponsorship']);
      } else if (/howdidyouhear|how_did_you_hear|source|referral/.test(key)) {
        await pickSelectOption(page, el, ['LinkedIn','Job board','Online','Internet','Other']);
      }
    } catch {}
  }
}

// ── Fill Dynamic Fields (AI-powered) ──────────────────────────────────────────
export async function fillDynamicFields(page) {
  const fields = await page.evaluate(() => {
    const results = [];

    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    for (const el of inputs) {
      const name = (el.name || el.id || '').toLowerCase();
      if (['first_name', 'last_name', 'fname', 'lname', 'name'].includes(name) || name.includes('email') || name.includes('phone') || el.type === 'file' || el.type === 'submit') continue;
      if (name.startsWith('iti-') || name.includes('__search-input') || name.includes('search-input')) continue;
      if (name.includes('ot-group-id') || name.includes('onetrust') || name.includes('vendor-search-handler') || name.includes('select-all-hosts') || name.includes('select-all-vendor') || name.includes('select-all-vendor-leg')) continue;
      if (el.closest('#onetrust-consent-sdk') || el.closest('#onetrust-pc-sdk') || el.closest('.onetrust-pc-dark-filter')) continue;
      if (el.disabled) continue;

      let labelText = '';
      if (el.labels && el.labels.length > 0) {
        labelText = Array.from(el.labels).map(l => l.innerText).join(' ');
      } else {
        const parent = el.closest('.field, .form-group, div');
        if (parent) labelText = parent.innerText.split('\n')[0];
      }

      // Skip Twitter / X fields as per user preference
      if (/twitter|x\.com/i.test(labelText) || /twitter|x\.com/i.test(name)) {
        continue;
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
      const cls = (el.className || '').toLowerCase();
      const parentCls = (el.parentElement?.className || '').toLowerCase();
      const isReactSelect = cls.includes('select__input') || cls.includes('select-field__input') ||
                            parentCls.includes('select__value-container') || parentCls.includes('select__input-container');
      if (isReactSelect) elType = 'reactselect';

      if (isReactSelect && el.id) {
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

    // Greenhouse combobox dropdowns
    const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    for (const el of comboboxes) {
      const id = el.id || '';
      if (!id) continue;
      
      // Skip Twitter / X fields as per user preference
      const name = (el.name || el.id || '').toLowerCase();
      const label = (document.querySelector(`label[for="${id}"]`)?.innerText || '').toLowerCase();
      if (/twitter|x\.com/i.test(label) || /twitter|x\.com/i.test(name)) {
        continue;
      }
      
      if (results.some(r => r.id === id)) continue;

      let labelText = '';
      const labelEl = document.querySelector(`label[for="${id}"]`);
      if (labelEl) {
        labelText = labelEl.innerText.trim();
      } else {
        const parent = el.closest('.field--select, .select-question, div');
        if (parent) labelText = parent.innerText.split('\\n')[0];
      }
      if (!labelText) continue;

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

  // Filter out GDPR/cookie consent fields
  const cleanedFields = fields.filter(f => {
    const n = (f.name || f.id || '').toLowerCase();
    if (n.startsWith('fc-preference') || n.startsWith('fc-vendor') || n.startsWith('didomi') || n.includes('consent-slider') || n.includes('gvl-vendor')) return false;
    if (n.includes('search_jobs') || n.includes('search_sort') || n.includes('search_location')) return false;
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

  // Static pre-fill
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

  // Fill static answers immediately
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
          await fillReactSelect(page, el, q.staticValue);
        } else {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(100);
          await el.focus().catch(() => {});
          await el.click({ clickCount: 3 }).catch(() => {});
          await page.waitForTimeout(100);
          
          const isFocusedStatic = await page.evaluate((el) => document.activeElement === el, el).catch(() => false);
          if (!isFocusedStatic) await el.focus().catch(() => {});

          // Explicitly click to open custom dropdowns (like spl-select)
          await el.click({ force: true }).catch(() => {});
          await page.waitForTimeout(200);

          await page.keyboard.type(q.staticValue, { delay: 10 });
          await page.waitForTimeout(1200); // Wait for dropdown

          const SUGGESTION_SELECTORS = [
            '[role="option"]',
            '[role="listbox"] li',
            'li[data-value]',
            'div[class*="_option_"]:not([class*="_container_"]):not([class*="_yesno_"])',
            '.autocomplete-suggestion',
            'ul.suggestions li',
            'spl-dropdown-item',
            'sr-autocomplete li'
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
              let best = null;
              const valLower = q.staticValue.toLowerCase();
              for (const opt of visibleOptions) {
                const txt = (await opt.textContent().catch(() => '')).trim().toLowerCase();
                if (txt.startsWith(valLower) || txt === valLower) { best = opt; break; }
              }
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
            await page.keyboard.press('Tab');
            await page.waitForTimeout(150);
          }
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

  // Re-verify static fields helper
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
- Notice Period: "Immediately", "Immediate", or "Available immediately" depending on options. ALWAYS prefer immediate availability.
- Salary: "55000" (or match the format shown in the form).
- Disability/Veteran/Gender: Always "Decline to answer", "Prefer not to say", or "No".
- Yes/No questions: answer "Yes" or "No" exactly unless options are different.
- Certification/consent questions ("I certify...", "I understand...", "I agree..."): answer "Yes".
- LinkedIn/GitHub links: ALWAYS include https://. LinkedIn → ${PROFILE.linkedin}, GitHub → ${PROFILE.github}.
- Location questions: pick "Remote" if available. Otherwise pick the single option closest to Germany/Berlin.
- "How did you hear": pick "LinkedIn" or the closest match from the options list.
- DO NOT invent values not in the options list for select/reactselect fields.
- DO NOT use actual newlines inside JSON strings. Use literal \\n if needed.
- Escape double quotes inside answer values with \\"`;

  const userPrompt = `Form Fields (for reactselect/select types, 'options' lists the EXACT values you may choose from):\n` + JSON.stringify(aiQuestions, null, 2);

  try {
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");

    let jsonString = match[0];
    jsonString = jsonString.replace(/(?<=:\s*")(.*?)(?="(?:\s*\}|\s*,))/gs, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, ''));

    const data = JSON.parse(jsonString);
    if (!data.answers) {
      console.log(`  ⚠️ AI fill error: No 'answers' array in JSON. Raw data: ${JSON.stringify(data).substring(0, 200)}`);
      return;
    }

    const qLabelMap = {};
    for (const q of aiQuestions) qLabelMap[q.name] = (q.label || '').toLowerCase();

    // Fix empty AI values
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
        if (!ans.value && ans.type !== 'checkbox') continue;
        
        // Skip Twitter / X fields completely to avoid triggering validation
        if (/twitter|x\.com/i.test(ans.name)) continue;

        const selector = ans.name.includes('question_') ? `[id="${ans.name}"], [name="${ans.name}"]` : `[name="${ans.name}"], [id="${ans.name}"]`;
        if (ans.type === 'radio' || ans.type === 'checkbox') {
          const valueSuffix = `[value="${ans.value}"]`;
          const specificSelector = selector.split(',').map(s => s.trim() + valueSuffix).join(', ');
          await page.click(specificSelector, { timeout: 1000, force: true }).catch(async () => {
             const els = await page.$$(selector);
             if (els.length > 0) {
               let clicked = false;
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
                       label.scrollIntoView({ block: 'center' });
                       label.click();
                       return (label.innerText || label.textContent)?.trim()?.substring(0, 60);
                     }
                     return null;
                   }, { groupName, prefix: ansPrefix }).catch(() => null);
                   console.log(`    🔍 Radio eval: groupName=${groupName.slice(-25)} prefix=${ansPrefix} result=${radioClicked?.substring(0,40)}`);
                   if (radioClicked) {
                     await page.waitForTimeout(500);
                     clicked = true;
                     console.log(`    ✅ Radio: "${radioClicked}"`);
                   }
                }
                if (!clicked) await els[0].check({ force: true }).catch(() => {});
             }
          });
        } else if (ans.type === 'select' || ans.type === 'select-one') {
          const selectFilled = await page.selectOption(selector, { value: ans.value }, { force: true, timeout: 3000 })
            .catch(() => page.selectOption(selector, { label: ans.value }, { force: true, timeout: 3000 }))
            .catch(() => null);
          if (!selectFilled) {
            const allSels = await page.$$('select');
            const targetLower = (ans.value || '').toLowerCase();
            let filled = false;
            for (const sel of allSels) {
              if (!await sel.isVisible().catch(() => false)) continue;
              const opts = await sel.evaluate(s =>
                Array.from(s.options).map(o => ({ v: o.value, l: o.text.trim() }))
              ).catch(() => []);
              if (!opts.length) continue;
              const exact = opts.find(o => o.l.toLowerCase() === targetLower);
              const partial = opts.find(o => o.l.toLowerCase().includes(targetLower) || targetLower.includes(o.l.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,5)));
              const eeoDefault = opts.find(o => /prefer not|decline|not disclose|i don.t wish/i.test(o.l));
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
          const rsInput = await page.$(`#${cssEscape(ans.name)}, [id="${ans.name}"]`).catch(() => null);
          if (rsInput) {
            await fillReactSelect(page, rsInput, ans.value);
          }
        } else if (ans.type === 'combobox') {
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
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.focus().catch(() => {});
                await el.click({ clickCount: 3 }).catch(() => {});
                await page.waitForTimeout(50);
                const isFocused2 = await page.evaluate((el) => document.activeElement === el, el).catch(() => false);
                if (!isFocused2) await el.focus().catch(() => {});
                
                // Explicitly click to open custom dropdowns (like spl-select)
                await el.click({ force: true }).catch(() => {});
                await page.waitForTimeout(200);

                await page.keyboard.type(ans.value, { delay: 10 });
                await page.waitForTimeout(800); // Wait for dropdown
                
                // Try to click an autocomplete dropdown option if it appeared (using Playwright to pierce shadow DOMs)
                const opts = await page.$$('sr-autocomplete li, [role="option"], .autocomplete-option, .dropdown-menu li, li[data-value], .select__option, .menu-item, spl-dropdown-item').catch(() => []);
                if (opts && opts.length > 0) {
                  let bestMatch = null;
                  const targetLower = ans.value.toLowerCase();
                  for (const o of opts) {
                    if (!await o.isVisible().catch(() => false)) continue;
                    const text = await o.textContent().catch(() => '');
                    if (text.trim().toLowerCase() === targetLower) { bestMatch = o; break; }
                    if (text.trim().toLowerCase().includes(targetLower)) { bestMatch = o; }
                  }
                  
                  if (bestMatch) {
                    await bestMatch.click({ force: true }).catch(() => {});
                    console.log(`    ↳ Picked dropdown option for ${ans.value}`);
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

  await reVerifyStaticFields();
}

// ── Convenience: fill all fields on a step ──────────────────────────────────
export async function fillAllFields(page, resumePath) {
  await fillBaseFields(page, resumePath);
  await fillDemographicFields(page);
  await fillDynamicFields(page);
}
