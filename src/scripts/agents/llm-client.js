/**
 * agents/llm-client.js — LLM Communication Agent
 * 
 * Handles all AI model calls with automatic fallback chains:
 *   Groq (8b → gemma2 → 8k → Gemini) for TPD limits
 *   Groq TPM retry with backoff
 *   Model decommission auto-switch
 * 
 * Exports:
 *   - callGroq(systemPrompt, userPrompt, model?) → string (JSON)
 *   - callGemini(systemPrompt, userPrompt) → string (JSON)
 *   - healAndRetry(page, context, maxAttempts?) → boolean
 */

// ── Gemini Fallback (1M tokens/day free) ───────────────────────────────────────
export async function callGemini(systemPrompt, userPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    console.log('  ⚠️ GEMINI_API_KEY not set — cannot use Gemini fallback');
    return '{}';
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.log(`  ⚠️ Gemini API Error: ${res.status} - ${errText.substring(0, 150)}`);
      return '{}';
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    console.log(`  ✅ Gemini 2.0 Flash responded (${text.length} chars)`);
    return text;
  } catch (e) {
    console.log(`  ⚠️ Gemini call failed: ${e.message}`);
    return '{}';
  }
}

// Ordered fallback chain — each model cascades to the NEXT one
const MODEL_CASCADE = [
  '__gemini__',                                       // Gemini 2.0 Flash — primary, best quality
  'llama-3.3-70b-versatile',                         // 100k TPD — Groq fallback, high quality
  'meta-llama/llama-4-scout-17b-16e-instruct',       // 500k TPD — 17b, very capable
  'mixtral-8x7b-32768',                              // 500k TPD — 47B MoE
  'llama-3.1-8b-instant',                             // 500k TPD — last resort
];

function getNextModel(currentModel) {
  const idx = MODEL_CASCADE.indexOf(currentModel);
  if (idx === -1 || idx >= MODEL_CASCADE.length - 1) return null;
  return MODEL_CASCADE[idx + 1];
}

export async function callGroq(systemPrompt, userPrompt, model = '__gemini__', _depth = 0) {
  // Recursion guard — prevent infinite loops
  if (_depth > MODEL_CASCADE.length + 2) {
    console.log(`  ⚠️ Max cascade depth reached — returning empty`);
    return '{}';
  }
  if (!process.env.GROQ_API_KEY) return '{}';

  // If we've cascaded all the way to Gemini, use it directly
  if (model === '__gemini__') {
    console.log(`  🔄 All Groq models exhausted → trying Gemini 2.0 Flash...`);
    return await callGemini(systemPrompt, userPrompt);
  }

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
      console.log(`  ⚠️ Groq API Error (${model}): ${res.status} - ${errText.substring(0,200)}`);
      
      // Model decommissioned or not found — skip to NEXT model in cascade (never loop back!)
      if (res.status === 400 && (errText.includes('decommissioned') || errText.includes('does not exist'))) {
        const next = getNextModel(model);
        if (next) {
          console.log(`  🔄 Model ${model} decommissioned → trying ${next}...`);
          return await callGroq(systemPrompt, userPrompt, next, _depth + 1);
        }
        return '{}';
      }

      if (res.status === 413) {
        const next = getNextModel(model);
        if (next) {
          console.log(`  🔄 Request too large for ${model} → trying ${next}...`);
          return await callGroq(systemPrompt, userPrompt, next, _depth + 1);
        }
        return '{}';
      }
      
      // TPD (daily token limit) — cascade to next model
      if (res.status === 429 && errText.includes('TPD')) {
        const next = getNextModel(model);
        if (next) {
          const nextLabel = next === '__gemini__' ? 'Gemini 2.0 Flash' : next;
          console.log(`  🔄 ${model} TPD limit → trying ${nextLabel}...`);
          return await callGroq(systemPrompt, userPrompt, next, _depth + 1);
        }
        console.log(`  ⚠️ All AI models hit daily limit. Applying with base resume...`);
        return '{}';
      }
      
      // TPM (per-minute token limit) — retry with backoff
      if (res.status === 429 && errText.includes('TPM')) {
        const waitMatch = errText.match(/try again in ([\d\.]+)s/);
        const waitTime = waitMatch ? (parseFloat(waitMatch[1]) * 1000) + 1000 : 15000;
        console.log(`  ⏳ TPM limit hit. Waiting ${Math.round(waitTime/1000)}s before retry...`);
        await new Promise(r => setTimeout(r, waitTime));
        return await callGroq(systemPrompt, userPrompt, model, _depth + 1);
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

// ── Self-Healing Agent Loop ────────────────────────────────────────────────────
/**
 * When a page action fails, capture DOM → ask Groq → execute fix → retry.
 * Used for validation error recovery and form navigation issues.
 * 
 * @param {import('playwright').Page} page
 * @param {object} context - Job object for context
 * @param {number} maxAttempts - Max heal attempts (default: 3)
 * @returns {boolean} true if errors were resolved
 */
export async function healAndRetry(page, context, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  🔧 Heal attempt ${attempt}/${maxAttempts} — analysing page...`);
    try {
      // 1. Capture current state
      const url = page.url();
      const bodyText = await page.textContent('body').catch(() => '');
      const visibleErrors = await page.evaluate(() => {
        const sels = [
          '.error', '.error-message', '[aria-invalid="true"]', '.alert-danger',
          '.validation-error', '.parsley-error', '[role="alert"]', '.invalid-feedback'
        ];
        return sels.flatMap(s => Array.from(document.querySelectorAll(s)))
          .filter(el => el.offsetParent !== null)
          .map(el => el.innerText.trim())
          .filter(t => t.length > 0)
          .slice(0, 5)
          .join(' | ');
      }).catch(() => '');

      // 2. Get simplified DOM snapshot (inputs + buttons only)
      const domSnapshot = await page.evaluate(() => {
        const fields = [];
        document.querySelectorAll('input:not([type=hidden]),select,textarea,button').forEach(el => {
          if (!el.offsetParent) return;
          const label = el.labels?.[0]?.innerText ||
            el.closest('[class*=field],[class*=form-group],div')?.querySelector('label')?.innerText ||
            el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || el.id || '';
          fields.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || el.id || '',
            label: label.trim().substring(0, 60),
            value: (el.type === 'password' ? '***' : (el.value || '').substring(0, 30)),
            required: el.required,
          });
        });
        return fields.slice(0, 40);
      }).catch(() => []);

      // 3. Ask Groq what to do
      const healPrompt = `You are controlling a Playwright browser applying to a job.
Current URL: ${url.substring(0, 120)}
Visible errors: ${visibleErrors || 'none'}
Page text snippet: ${bodyText.substring(0, 600)}
Visible form fields (JSON): ${JSON.stringify(domSnapshot)}

The last action failed. Analyse what went wrong and return a single JSON action to recover.
Return ONLY valid JSON in one of these formats:
{"action":"fill","selector":"CSS or text selector","value":"value to type"}
{"action":"click","selector":"CSS or text selector"}
{"action":"select","selector":"CSS selector","value":"option text"}
{"action":"scroll_and_click","selector":"CSS or text selector"}
{"action":"wait","ms":2000}
{"action":"give_up","reason":"why this page cannot be completed"}

Rules:
- CRITICAL: If the page text mentions 'flagged as spam', 'flagged as possible spam', 'submission blocked', 'bot', 'automated', 'application limits', 'already applied', or 'rate limit', return give_up immediately — these are PERMANENT blocks that cannot be fixed by clicking again
- If required fields are empty or showing errors, fill them with the correct value
- If a dropdown has no selection, select the most appropriate option
- If it's a captcha page (hCaptcha, reCAPTCHA), give_up
- If a multi-step form is stuck on a step, click the Next or Continue button
- Use specific selectors like button:has-text("Submit") or input[name="phone"]
- Do NOT suggest clicking "Submit your application again" — that is not a real fix for spam blocks`;

      const raw = await callGroq(
        'You are a browser automation agent. Return only valid JSON.',
        healPrompt,
        'llama-3.3-70b-versatile'
      );

      let action;
      try { action = JSON.parse(raw); } catch { continue; }

      console.log(`  🤖 Heal action: ${JSON.stringify(action)}`);

      if (action.action === 'give_up') {
        console.log(`  🛑 Agent says give up: ${action.reason}`);
        return false;
      }

      // 4. Execute the action
      if (action.action === 'fill' && action.selector && action.value !== undefined) {
        const el = await page.locator(action.selector).first().catch(() => null);
        if (el) { await el.fill(String(action.value), { timeout: 5000 }).catch(() => {}); }
      } else if (action.action === 'click' && action.selector) {
        await page.locator(action.selector).first().click({ timeout: 5000, force: true }).catch(() => {});
      } else if (action.action === 'select' && action.selector && action.value) {
        await page.locator(action.selector).first().selectOption({ label: action.value }, { timeout: 5000 }).catch(
          () => page.locator(action.selector).first().selectOption(action.value, { timeout: 3000 }).catch(() => {})
        );
      } else if (action.action === 'scroll_and_click' && action.selector) {
        const el = await page.locator(action.selector).first().catch(() => null);
        if (el) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.click({ force: true }).catch(() => {}); }
      } else if (action.action === 'wait') {
        await page.waitForTimeout(action.ms || 2000);
      }

      await page.waitForTimeout(1500);

      // 5. Check if errors cleared or page progressed
      const newErrors = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.error,.error-message,[aria-invalid="true"],[role="alert"]'))
          .filter(el => el.offsetParent !== null && el.innerText.trim().length > 0).length;
      }).catch(() => 1);

      if (newErrors === 0) {
        console.log(`  ✅ Heal attempt ${attempt} cleared errors!`);
        return true;
      }
    } catch (healErr) {
      console.log(`  ⚠️ Heal attempt ${attempt} error: ${healErr.message}`);
    }
  }
  return false;
}
