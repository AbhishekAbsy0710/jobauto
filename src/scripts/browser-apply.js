#!/usr/bin/env node
/**
 * Playwright Browser Auto-Apply (AI Powered)
 * Dynamically fills out forms using Groq API
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
chromium.use(stealth());
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RESUME_PATH = join(ROOT, 'resume', 'resume.pdf');

// Load .env
try {
  const envFile = readFileSync(join(ROOT, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const PROFILE_YAML = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8').substring(0, 2000);

const PROFILE = {
  firstName: 'Abhishek Raj',
  lastName: 'Pagadala',
  fullName: 'Abhishek Raj Pagadala',
  email: process.env.APPLICANT_EMAIL || 'pagadalaabhishek60@gmail.com',
  phone: process.env.APPLICANT_PHONE || '+49 176 6723 9250',
  linkedin: 'https://www.linkedin.com/in/abhishek-raj-pagadala',
  github: 'https://github.com/AbhishekAbsy0710',
  city: 'Munich',
  country: 'Germany',
};

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

async function sendDiscordEmbed(embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JobAuto', embeds: [embed] })
    });
  } catch {}
}

async function callGroq(systemPrompt, userPrompt, model = 'llama-3.1-8b-instant') {
  if (!process.env.GROQ_API_KEY) return '{}';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.log(`  ⚠️ Groq API Error (${model}): ${res.status} - ${errText}`);
      
      if (res.status === 413) {
        if (model === 'llama-3.1-8b-instant') {
          console.log(`  🔄 Request too large for 8b, trying 70b...`);
          return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
        }
        return '{}';
      }
      
      if (res.status === 429 && model === 'llama-3.1-8b-instant' && errText.includes('TPD')) {
        console.log(`  🔄 Retrying with fallback model: llama-3.3-70b-versatile`);
        return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
      }
      
      if (res.status === 429 && model === 'llama-3.3-70b-versatile' && errText.includes('TPD')) {
        console.log(`  ⚠️ Both models hit TPD limit. Skipping...`);
        return '{}';
      }
      
      if (res.status === 429 && errText.includes('TPM')) {
        const waitMatch = errText.match(/try again in ([\d\.]+)s/);
        const waitTime = waitMatch ? (parseFloat(waitMatch[1]) * 1000) + 1000 : 15000;
        console.log(`  ⏳ TPM limit hit. Waiting ${Math.round(waitTime/1000)}s before retry...`);
        await new Promise(r => setTimeout(r, waitTime));
        return await callGroq(systemPrompt, userPrompt, model);
      }
      
      return '{}';
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '{}';
  } catch (networkErr) {
    console.log(`  ⚠️ Groq network error: ${networkErr.message}`);
    return '{}';
  }
}

// ============================================
// STATIC ANSWER CACHE — skips Groq for common fields
// ============================================
const STATIC_ANSWERS = [
  // Legal work authorisation MUST come first to prevent country pattern matching "in the country where..."
  { patterns: [/legally auth/i, /authorised.*work/i, /authorized.*work/i], value: 'Yes, no restriction.', type: 'reactselect' },
  // LinkedIn
  { patterns: [/linkedin/i], value: 'https://www.linkedin.com/in/abhishek-raj-pagadala', type: 'text' },
  // GitHub
  { patterns: [/github/i, /portfolio.*url/i], value: 'https://github.com/AbhishekAbsy0710', type: 'text' },
  // Website/Portfolio (generic)
  { patterns: [/website/i, /personal.*url/i, /your.*website/i], value: 'https://github.com/AbhishekAbsy0710', type: 'text' },
  // Location / city — ONLY match simple "city" labels, NOT "location(s) to work" dropdowns
  { patterns: [/^city$/i, /current.*city/i, /^location$/i, /where.*are.*you.*based/i, /city.*you.*live/i], value: 'Munich', type: 'text' },
  // Country — matches all country variants including Passport Country and Country of Residence
  { patterns: [/^country$/i, /country.*reside/i, /country.*live/i, /country.*located/i, /country.*currently/i, /country.*origin/i, /passport.*country/i, /country.*passport/i, /country.*citizenship/i, /nationality/i], value: 'Germany', type: 'text' },
  // Salary
  { patterns: [/salary.*expectation/i, /expected.*salary/i, /desired.*salary/i, /compensation/i], value: '55000', type: 'text' },
  // Notice period
  { patterns: [/notice.*period/i, /start.*date/i, /available.*start/i], value: 'Immediate', type: 'text' },
  // Preferred name
  { patterns: [/preferred.*name/i, /preferred first/i], value: 'Abhishek', type: 'text' },
  // Twitter/X profile
  { patterns: [/twitter/i, /\bx\.com\b/i, /x\s*\/\s*twitter/i, /twitter.*profile/i], value: 'https://x.com/AbhishekAbsy', type: 'text' },
  // Pronouns
  { patterns: [/pronoun/i], value: 'He/him', type: 'text' },
  // Visa sponsorship (plain radio/select)
  { patterns: [/\brequire.*visa\b/i, /\bneed.*visa.*sponsor/i, /\bvisa.*required\b/i], value: 'No', type: 'radio' },
  // Work authorization (plain text/radio)
  { patterns: [/work.*authoriz/i, /work.*permit/i, /right.*to.*work/i], value: 'Yes', type: 'radio' },
  // "How did you hear" — let AI answer (dropdown with specific options per company)
];



function tryStaticAnswer(labelText) {
  // Strip required markers (* \u25cf etc) and trim before matching
  const label = (labelText || '').replace(/[*\u25cf\u2022\uFE0F]+/g, '').trim().toLowerCase();
  for (const rule of STATIC_ANSWERS) {
    if (rule.patterns.some(p => p.test(label))) {
      return { value: rule.value, type: rule.type };
    }
  }
  return null;
}

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
          // Try named selector first, then fall back to scanning all selects by option text
          const selectFilled = await page.selectOption(selector, { value: ans.value }, { force: true, timeout: 3000 })
            .catch(() => page.selectOption(selector, { label: ans.value }, { force: true, timeout: 3000 }))
            .catch(() => null);
          if (!selectFilled) {
            // Fallback: find any visible select whose options include the desired value
            const allSels = await page.$$('select');
            for (const sel of allSels) {
              if (!await sel.isVisible().catch(() => false)) continue;
              const picked = await sel.selectOption({ label: ans.value }, { timeout: 1000 })
                .catch(() => sel.selectOption({ value: ans.value }, { timeout: 1000 }))
                .catch(() => null);
              if (picked) break;
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

// ============================================
// COOKIE BANNER DISMISSAL
// ============================================
async function dismissCookieBanners(page) {
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
  for (const btn of applyBtns) {
    try { await btn.click({ timeout: 2000 }); await page.waitForTimeout(2000); break; } catch {}
  }

  // Name — covers Greenhouse (first_name/last_name), Lever (name), Ashby (_systemfield_name)
  await fillField(page, '#first_name, input[name="first_name"], input[name*="first"]:not([name*="preferred"])', PROFILE.firstName);
  await fillField(page, '#last_name, input[name="last_name"], input[name*="last"]', PROFILE.lastName);
  await fillField(page, '#preferred_name, input[name="preferred_name"], input[name*="preferred"]', PROFILE.firstName);
  await fillField(page, 'input[name="name"], input[name="cards[0][field0]"]', PROFILE.fullName); // Lever
  await fillField(page, 'input[name="_systemfield_name"]', PROFILE.fullName); // Ashby

  // Email & Phone
  await fillField(page, '#email, input[name="email"], input[type="email"], input[name="_systemfield_email"]', PROFILE.email);
  await fillField(page, '#phone, input[name="phone"], input[type="tel"], input[name="_systemfield_phone"]', PROFILE.phone);

  // Socials / Location
  await fillField(page, 'input[name*="linkedin"], input[id*="linkedin"]', PROFILE.linkedin);
  await fillField(page, 'input[name*="location"], input[id*="location"], input[placeholder*="City"]', PROFILE.city);

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
// DYNAMIC RESUME TAILORING
// ============================================
async function generateTailoredResume(job, context, supabase, fallbackPath) {
  const baseJsonPath = join(ROOT, 'resume', 'base-resume.json');
  if (!existsSync(baseJsonPath)) return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };

  console.log(`  🤖 Tailoring resume for ${job.company} - ${job.title}...`);
  const baseJsonStr = readFileSync(baseJsonPath, 'utf8');

  const sysPrompt = `You are an expert technical recruiter. Your task is to tailor the candidate's resume for the target Job Description to maximize ATS match.

CRITICAL RULES — NEVER violate these:
- You MUST NOT change any job title, company name, date, or bullet point in the candidate's work experience section.
- You MUST NOT invent, add, or remove any work experience entries.
- You MUST NOT change the candidate's education, certifications, or contact information.
- The ONLY things you are allowed to change are: the professional headline (title), the summary paragraph, and the skills list.

You are ONLY allowed to output three things in JSON format:
1. "title": A new professional headline that closely matches the target job title (e.g. "Senior Data Engineer" or "Cloud Platform Engineer"). This goes at the top of the resume as the candidate's current professional title — it does NOT modify any job entry.
2. "summary": A tailored professional summary (3-4 sentences) that highlights the candidate's existing experience relevant to this job. Do NOT invent new experience.
3. "new_skills": An array of 3-8 relevant technical skills/keywords from the Job Description that the candidate realistically possesses based on their base resume.

Return ONLY valid JSON:
{
  "title": "string",
  "summary": "string",
  "new_skills": ["string"]
}`;

  const userPrompt = `Job Title: ${job.title}\nJob Company: ${job.company}\nJob Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nCandidate's Base Resume:\n${baseJsonStr}`;

  let tailoredJson = JSON.parse(baseJsonStr);
  
  try {
    console.log(`  🔄 Generating tailored Summary, Title, and Skills...`);
    const res = await callGroq(sysPrompt, userPrompt);
    const match = res.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    
    const patchJson = JSON.parse(match[0]);
    
    if (Object.keys(patchJson).length === 0) {
      throw new Error("AI returned empty JSON (likely rate limited)");
    }
    
    let changesMadeArr = [];
    
    // Apply patches safely
    if (patchJson.title && patchJson.title !== tailoredJson.personal.title) {
        tailoredJson.personal.title = patchJson.title;
        changesMadeArr.push(`Updated title to '${patchJson.title}'`);
    }
    if (patchJson.summary && patchJson.summary !== tailoredJson.summary) {
        tailoredJson.summary = patchJson.summary;
        changesMadeArr.push('Tailored summary');
    }
    if (patchJson.new_skills && Array.isArray(patchJson.new_skills) && patchJson.new_skills.length > 0) {
        tailoredJson.skills['Tailored Skills'] = patchJson.new_skills.join(', ');
        changesMadeArr.push(`Added ${patchJson.new_skills.length} targeted skills`);
    }
    
    tailoredJson.changes_made = changesMadeArr.length > 0 ? changesMadeArr.join(', ') : 'Base Resume (No modifications)';
    
    if (changesMadeArr.length === 0) {
      throw new Error("No meaningful changes were made by AI");
    }

    // Evaluate the new tailored resume
    console.log(`  📊 Evaluating tailored resume...`);
    const evalSysPromptJson = `You are a strict ATS (Applicant Tracking System). Compare the Candidate's Resume against the Job Description. Return a JSON object with a single key "score" containing an integer from 0 to 100 representing the match percentage.`;
    const evalUserPrompt = `Job Description:\n${job.description ? job.description.substring(0, 3000) : job.title}\n\nResume JSON:\n${JSON.stringify(tailoredJson)}`;
    const scoreRes = await callGroq(evalSysPromptJson, evalUserPrompt, 'llama-3.1-8b-instant');
    let score = 0;
    try {
        const scoreMatch = scoreRes.match(/\{[\s\S]*\}/);
        if (scoreMatch) {
            score = JSON.parse(scoreMatch[0]).score || 0;
        }
    } catch(err) {
        score = parseInt(scoreRes.replace(/\D/g, '')) || 0;
    }
    console.log(`  📈 ATS Score: ${score}%`);
    
  } catch(e) {
    console.log(`  ⚠️ Failed to generate tailored resume sections (${e.message}), using base.`);
    return { pdfPath: fallbackPath, publicUrl: null, changes: 'Base Resume (No modifications)' };
  }

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

  return { pdfPath: outputPath, publicUrl, changes: tailoredJson.changes_made || 'Tailored resume to match job description' };
}

// ============================================
// MAIN
// ============================================
async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  let query = supabase
    .from('jobs')
    .select('*, evaluations(id, letter_grade, weighted_score)')
    .eq('status', 'auto_queue');

  // TEST MODE: restrict to a single job ID for safe testing
  if (process.env.TEST_JOB_ID) {
    console.log(`🧪 TEST MODE — running only job ID ${process.env.TEST_JOB_ID}`);
    query = query.eq('id', process.env.TEST_JOB_ID);
  }

  const { data: rawJobs, error } = await query;

  if (error || !rawJobs || rawJobs.length === 0) {
    console.log('📭 No jobs in the apply queue');
    return;
  }

  let jobs = rawJobs.map(j => {
    const e = Array.isArray(j.evaluations) ? j.evaluations[0] : j.evaluations;
    return { ...j, eval_id: e?.id, grade: e?.letter_grade, score: e?.weighted_score || 0 };
  }).sort((a, b) => b.score - a.score);

  // LIMIT: Max 10 jobs per run to stay within Groq free tier (100k TPD)
  const MAX_JOBS_PER_RUN = 10;
  if (jobs.length > MAX_JOBS_PER_RUN) {
    console.log(`  📊 ${jobs.length} jobs queued — capping to top ${MAX_JOBS_PER_RUN} by score`);
    jobs = jobs.slice(0, MAX_JOBS_PER_RUN);
  }

  console.log(`\n🚀 Auto-applying to ${jobs.length} jobs via Playwright (AI Enabled)...\n`);

  const isHeaded = process.env.HEADED === 'true';
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
  context.setDefaultTimeout(10000);

  const results = { applied: 0, failed: 0, skipped: 0 };
  const appliedJobs = [];
  const failedJobs = [];

  // Target roles — IT/engineering keywords that must appear in the title
  const TARGET_KEYWORDS = [
    'data engineer', 'data analyst', 'data scientist', 'analytics engineer',
    'devops', 'cloud engineer', 'cloud architect', 'platform engineer',
    'backend', 'fullstack', 'full stack', 'full-stack',
    'software engineer', 'software developer',
    'ai engineer', 'ml engineer', 'machine learning', 'mlops',
    'infrastructure engineer', 'site reliability', 'sre',
    'frontend engineer', 'frontend developer',
    'tech lead', 'lead engineer', 'staff engineer', 'principal engineer',
    'automation engineer', 'automation developer',
    'solutions architect', 'cloud consultant', 'devops consultant',
    'data platform', 'data infrastructure',
    'ki-agent', 'ki engineer',
    'security engineer', 'security analyst', 'cybersecurity', 'devsecops', 'appsec', 'cloud security',
    'it support', 'it specialist', 'systems engineer', 'systems administrator', 'sysadmin',
    'network engineer', 'network administrator', 'network architect',
  ];
  // Non-IT roles to hard-skip regardless of other signals
  const SKIP_KEYWORDS = [
    // Trades / manual / non-tech (German)
    'kosmetik', 'werkstudent', 'praktikum', 'praktikant', 'pflege', 'fahrer',
    'tischler', 'maler', 'fotovoltaik', 'photovoltaik', 'elektriker',
    'reinigung', 'handwerk', 'schweißer', 'sanitär', 'lagerlogistik',
    'sozialarbeiter', 'krankenpflege', 'bürokaufmann', 'kaufmann',
    'steuerberater', 'buchhalter',
    // Marketing / social media
    'influencer', 'marketing manager', 'social media manager',
    'community manager', 'brand manager', 'seo manager',
    'performance marketing', 'campaign manager', 'content creator',
    'copywriter', 'redakteur', 'tiktok', 'reels', 'journalist',
    // Sales / BD
    'sales manager', 'sales representative', 'sales engineer',
    'account executive', 'account manager', 'business development',
    'customer success manager', 'partnership manager', 'revenue operations',
    // Non-IC management
    'engineering manager', 'vp of engineering', 'head of engineering',
    'director of engineering', 'chief technology officer',
    'tax lead', 'tax manager', 'tax consultant', 'finance manager',
    'hr manager', 'recruiter', 'talent acquisition', 'people operations',
    // Technical but out-of-scope
    'c++ developer', 'embedded', 'firmware', 'hardware engineer',
    'mechanical engineer', 'civil engineer', 'chemical engineer',
    'nurse', 'doctor', 'physician',
    'personalberater',
  ];

  // Per-company application cap — Ashby/Greenhouse block after 2-3 apps from same person
  const MAX_PER_COMPANY = 2;
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
            const applyBtn = await page.$('a[class*="apply"], button[class*="apply"], a:has-text("Apply Now"), a:has-text("Apply"), a:has-text("Jetzt bewerben"), a:has-text("Bewerben")').catch(() => null);
            if (applyBtn) {
              const [newPage] = await Promise.race([
                Promise.all([page.context().waitForEvent('page', { timeout: 5000 }), applyBtn.click()]),
                new Promise(r => setTimeout(() => r([null]), 5000))
              ]).catch(() => [null]);
              if (newPage && newPage.url && newPage.url() !== 'about:blank') {
                realApplyUrl = newPage.url();
                await newPage.close().catch(() => {});
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
          console.log(`  ✅ Found real ATS: ${realApplyUrl.substring(0, 80)}`);
          // Update stored apply_link so we skip this lookup next time
          try { await supabase.from('jobs').update({ apply_link: realApplyUrl, platform: new URL(realApplyUrl).hostname.replace('www.','').split('.')[0] }).eq('id', job.id); } catch(e) {}
          await page.goto(realApplyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000 + Math.random() * 1000);
        } else {
          // Archive it — ArbeitNow listing with no extractable apply link
          await supabase.from('jobs').update({ status: 'archived', notes: 'ArbeitNow: no external apply URL found' }).eq('id', job.id).catch(() => {});
          throw new Error('Job board page — could not find external apply URL (archived)');
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
        console.log(`  🔀 ATS embedded in iframe — using fresh token from live page: ${iframeUrl.substring(0, 80)}...`);
        // Store the fresh iframe URL for next time
        try { await supabase.from('jobs').update({ apply_link: iframeUrl }).eq('id', job.id); } catch(e) {}
        await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000 + Math.random() * 1000);
      }


      // Pre-flight: detect dead/404 pages before wasting API tokens
      const pageText = await page.textContent('body').catch(() => '');
      const pageLower = pageText.toLowerCase();
      const preflightUrl = page.url().toLowerCase();


      // Early captcha/bot detection — skip immediately
      if (pageLower.includes('please solve this captcha') || pageLower.includes('verify you are human') || pageLower.includes('checking if the site connection is secure') || pageLower.includes('just a moment') || pageLower.includes('enable javascript and cookies')) {
        throw new Error('Captcha/bot detection — marking for manual apply');
      }

      // Detect login walls (Workday, Spotify/Teamtailor, LinkedIn Easy Apply gating)
      if (preflightUrl.includes('myworkdayjobs.com') || preflightUrl.includes('workday.com/en-us/signin')) {
        throw new Error('Workday login wall — requires manual apply');
      }
      if (preflightUrl.includes('teamtailor.com') && (pageLower.includes('sign in') || pageLower.includes('log in') || pageLower.includes('create account'))) {
        throw new Error('Teamtailor login wall — requires manual apply');
      }

      if (pageLower.includes('page not found') || pageLower.includes(' 404 ') || pageLower.startsWith('404') || pageLower.includes('the job you requested was not found') || pageLower.includes('this position has been filled') || pageLower.includes('this job is no longer available') || pageLower.includes('no longer accepting applications') || pageLower.includes('position is no longer available')) {
        throw new Error('Dead page: job listing removed or expired');
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
      const MAX_STEPS = 10;
      let submitted = false;
      let stepCount = 0;

      const SUBMIT_SELECTORS = [
        // Generic
        'button[type="submit"]',
        'input[type="submit"]',
        // Ashby
        'button:has-text("Submit Application")',
        'button:has-text("Submit application")',
        'button[data-testid="ashby-btn-primary"]',
        '.ashby-application-form-submit-button',
        // Greenhouse
        '#submit_app', '#submit-app',
        'button#submit_app',
        'input#submit_app',
        // Lever
        'button.postings-btn.template-btn-submit',
        'a.postings-btn',
        // Generic text
        'button:has-text("Submit")',
        'button:has-text("Apply")',
        'button:has-text("Apply Now")',
        'button:has-text("Send Application")',
        'button:has-text("Send your application")',
        'button:has-text("Bewerbung absenden")',
        'button:has-text("Jetzt bewerben")',
        // Workday
        'button[data-automation-id="bottom-navigation-next-button"]',
        'button[data-automation-id="bottom-navigation-review-btn"]',
        // Teamtailor (Spotify)
        'button[data-testid="submit-button"]',
        'button.button--primary:has-text("Send application")',
        'button.button--primary:has-text("Apply")',
        // Misc
        'button.submit-application',
        '[data-action="submit"]',
        'button[aria-label*="submit" i]',
        'button[aria-label*="apply" i]',
      ];
      const NEXT_SELECTORS = [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Weiter")',
        'button:has-text("Next Step")',
        'button:has-text("Next Page")',
        'button:has-text("Review")',
        'button[data-testid="next-button"]',
        'button[data-testid="continue"]',
        // Workday
        'button[data-automation-id="bottom-navigation-next-button"]',
        'a:has-text("Next")',
        'a:has-text("Continue")',
        '.next-btn', '#next-button',
        'button[aria-label*="next" i]',
      ];
      const FINAL_PAGE_SIGNALS = ['review your application', 'review and submit', 'überprüfen', 'zusammenfassung'];

      while (!submitted && stepCount < MAX_STEPS) {
        stepCount++;
        console.log(`  📄 Form step ${stepCount}/${MAX_STEPS}...`);

        // Re-fill fields on every new step (each step = new DOM)
        await fillBaseFields(page, activeResumePath);
        await fillDemographicFields(page);
        await fillDynamicFields(page);
        await page.waitForTimeout(800);

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
              console.log(`  ⏳ Waiting up to 10 min — run: echo "CODE" > /Users/abhishek/Documents/jobauto/security_code.txt`);
              
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
          throw new Error(`No Submit or Next button found on step ${stepCount}`);
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

      // --- Bot/Captcha detection ---
      if (postSubmitLower.includes('please solve this captcha') || postSubmitLower.includes('verify you are human') || postSubmitLower.includes('checking if the site connection is secure') || postSubmitLower.includes('just a moment')) {
         job.hasCaptcha = true;
         throw new Error('Captcha Blocked Submission');
      }

      // --- Spam/bot block detection ---
      if (postSubmitLower.includes('flagged as possible spam') || postSubmitLower.includes('flagged as spam') || postSubmitLower.includes('submission was blocked') || postSubmitLower.includes('robot') || postSubmitLower.includes('automated submission')) {
        throw new Error('Submission blocked as spam/bot by ATS');
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
      }
      
      const needsEmailVerification = postSubmitLower.includes('check your email') || 
                                     postSubmitLower.includes('verify your email') || 
                                     postSubmitLower.includes('confirm your email') ||
                                     url.includes('join.com');

      // --- Platform-specific success: Lever SPA never changes URL ---
      const isLever = url.includes('jobs.lever.co') || url.includes('lever.co');
      const isAshby = url.includes('ashbyhq.com') || url.includes('jobs.ashby');
      const leverSuccess = isLever && !hasErrors && (
        postSubmitLower.includes('application has been submitted') ||
        postSubmitLower.includes('your application was submitted') ||
        postSubmitLower.includes('thanks for applying') ||
        postSubmitLower.includes("we'll be in touch") ||
        postSubmitLower.includes('we received your application') ||
        submitButtonGone
      );
      const ashbySuccess = isAshby && !hasErrors && submitButtonGone;

      // SUCCESS = explicit signal OR (no errors + URL changed + submit gone) OR platform-specific
      const isSuccess = !hasErrors && (isSuccessUrl || isSuccessText || (urlChanged && submitButtonGone) || leverSuccess || ashbySuccess);
      
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

        // Upload proof screenshot to 'proofs' path to keep it separate from resume PDFs
        let screenshotUrl = null;
        try {
          const screenshotPath = join(ROOT, `proof_${job.eval_id}.jpeg`);
          await page.screenshot({ path: screenshotPath, fullPage: true, quality: 40, type: 'jpeg' });
          const screenshotBuffer = readFileSync(screenshotPath);
          const proofFileName = `proof_${job.eval_id}_${Date.now()}.jpeg`;
          await supabase.storage.from('screenshots').upload(proofFileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
          screenshotUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${proofFileName}`;
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
        throw new Error('Validation error or missing success confirmation');
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
  }

  await browser.close();

  console.log(`\n📊 Results: ${results.applied} applied, ${results.failed} failed, ${results.skipped || 0} skipped\n`);

  for (const aj of appliedJobs) {
    const proofUrl = aj.screenshotUrl || undefined;
    const coldEmailStatus = aj.coldEmailSent
      ? `✅ Cold email sent to \`${aj.coldEmailTarget}\``
      : `❌ Cold email not sent${aj.coldEmailError ? ` (${aj.coldEmailError})` : ''}`;
    
    const fields = [
      { name: '⭐ ATS Score', value: `${aj.score ? aj.score.toFixed(1) : '?'} / 5.0`, inline: true },
      { name: '📄 Resume Used', value: aj.resumeUsed || basename(RESUME_PATH), inline: true },
      { name: '📧 Cold Email', value: coldEmailStatus, inline: false }
    ];
    if (aj.coldEmailSent && aj.coldEmailSubject) {
      fields.push({ name: '✉️ Subject', value: aj.coldEmailSubject.substring(0, 256), inline: false });
      fields.push({ name: '📝 Body', value: aj.coldEmailBody ? `\`\`\`text\n${aj.coldEmailBody.substring(0, 1000)}\n\`\`\`` : 'No body', inline: false });
    }

    await sendDiscordEmbed({
      title: `✅ Auto-Applied: ${aj.title}`,
      description: `Successfully applied to **${aj.company}**!${aj.needsEmailVerification ? '\n\n⚠️ **ATTENTION:** This platform requires email verification. Please check your inbox and click the confirmation link to finalize your application!' : ''}`,
      color: 0x00d2a0,
      fields: fields,
      image: proofUrl ? { url: proofUrl } : undefined,
      timestamp: new Date().toISOString()
    });
    // Tiny delay to avoid Discord rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  if (failedJobs.length > 0) {
    for (const fj of failedJobs) {
      // Upload error screenshot to 'proofs' path — SEPARATE from resume pdf_path
      let errorProofUrl = null;
      if (fj.errorScreenshotPath && existsSync(fj.errorScreenshotPath)) {
        try {
          const screenshotBuffer = readFileSync(fj.errorScreenshotPath);
          const fileName = `error_${fj.eval_id}_${Date.now()}.jpeg`;
          await supabase.storage.from('screenshots').upload(fileName, screenshotBuffer, { upsert: true, contentType: 'image/jpeg' });
          errorProofUrl = `https://swscpdtchfjyzpjhwqqj.supabase.co/storage/v1/object/public/screenshots/${fileName}`;
        } catch (err) {}
      }

      const failureReason = fj.hasCaptcha ? 'Captcha Blocked' : (fj.errorMessage || 'Validation Error');

      await supabase.from('applications').insert({
        evaluation_id: fj.eval_id,
        method: failureReason.substring(0, 100),
        status: 'failed',
        pdf_path: fj.tailoredPublicUrl || null,       // resume PDF (may be null if failed before tailoring)
        screenshot_url: errorProofUrl || null,         // error screenshot — NEVER mixed with pdf_path
        applied_at: new Date().toISOString()
      });

      await sendDiscordEmbed({
        title: `⚠️ Auto-Apply Failed: ${fj.title}`,
        description: `Failed to auto-apply to **${fj.company}**. Returned to **Manual Queue**.`,
        color: 0xff4500,
        fields: [
          { name: '❌ Reason', value: failureReason.substring(0, 100), inline: false },
          { name: '👉 Apply Manually', value: `[Click Here](${fj.apply_link})`, inline: false }
        ],
        image: errorProofUrl ? { url: errorProofUrl } : undefined,
        timestamp: new Date().toISOString()
      });
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
