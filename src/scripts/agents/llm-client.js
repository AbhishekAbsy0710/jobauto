/**
 * agents/llm-client.js — LLM Communication Agent
 * 
 * Centralized AI/LLM calls with automatic model cascading and rate-limit handling.
 * Models cascade: llama-3.1-8b → gemma2-9b → llama3-8b-8192 → llama-3.3-70b → Gemini 2.0 Flash
 * 
 * Exports:
 *   - askAI(systemPrompt, userPrompt, opts) — main entry point
 *   - callGroq(systemPrompt, userPrompt, model) — direct Groq call
 *   - callGemini(systemPrompt, userPrompt) — direct Gemini call
 */

// ── Gemini fallback (1M tokens/day free) ──────────────────────────────────────
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

// ── Groq with model cascade and rate-limit handling ──────────────────────────
export async function callGroq(systemPrompt, userPrompt, model = 'llama-3.1-8b-instant') {
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
      console.log(`  ⚠️ Groq API Error (${model}): ${res.status} - ${errText.substring(0,200)}`);
      
      // Model decommissioned — try 70b
      if (res.status === 400 && errText.includes('decommissioned')) {
        if (model !== 'llama-3.3-70b-versatile') {
          console.log(`  🔄 Model decommissioned, switching to llama-3.3-70b-versatile...`);
          return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
        }
        return '{}';
      }

      if (res.status === 413) {
        if (model !== 'llama-3.3-70b-versatile') {
          console.log(`  🔄 Request too large, trying 70b...`);
          return await callGroq(systemPrompt, userPrompt, 'llama-3.3-70b-versatile');
        }
        return '{}';
      }
      
      // TPD (daily token limit) cascade:
      //   llama-3.1-8b-instant : 500k TPD  (default)
      //   gemma2-9b-it         : 500k TPD  (fallback #1)
      //   llama3-8b-8192       : 500k TPD  (fallback #2)
      //   Gemini 2.0 Flash     : 1M  TPD   (fallback #3 — virtually unlimited)
      //   → apply with base resume          (last resort)
      if (res.status === 429 && errText.includes('TPD')) {
        if (model === 'llama-3.1-8b-instant') {
          console.log(`  🔄 8b TPD limit → trying gemma2-9b-it...`);
          return await callGroq(systemPrompt, userPrompt, 'gemma2-9b-it');
        }
        if (model === 'gemma2-9b-it') {
          console.log(`  🔄 gemma2 TPD limit → trying llama3-8b-8192...`);
          return await callGroq(systemPrompt, userPrompt, 'llama3-8b-8192');
        }
        if (model === 'llama3-8b-8192') {
          console.log(`  🔄 All Groq models hit daily limit → trying Gemini 2.0 Flash...`);
          return await callGemini(systemPrompt, userPrompt);
        }
        console.log(`  ⚠️ All AI models hit daily limit. Applying with base resume...`);
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

// ── Unified AI entry point ──────────────────────────────────────────────────
/**
 * Ask AI a question with automatic model selection.
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @param {object} opts - Options
 * @param {string} opts.model - Override model (default: 'llama-3.1-8b-instant')
 * @param {boolean} opts.preferGemini - Use Gemini directly (default: false)
 * @returns {string} Raw JSON string from AI
 */
export async function askAI(systemPrompt, userPrompt, opts = {}) {
  if (opts.preferGemini) {
    return await callGemini(systemPrompt, userPrompt);
  }
  return await callGroq(systemPrompt, userPrompt, opts.model || 'llama-3.1-8b-instant');
}

// ── Self-Healing Agent Loop ──────────────────────────────────────────────────
/**
 * When a page action fails, capture DOM → ask AI → execute fix → retry.
 * Uses llama-3.3-70b-versatile for complex reasoning.
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

      // 2. Get simplified DOM snapshot (inputs + buttons only, truncated)
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

      // 3. Ask AI what to do
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
        return true;  // caller should retry the submit
      }
    } catch (healErr) {
      console.log(`  ⚠️ Heal attempt ${attempt} error: ${healErr.message}`);
    }
  }
  return false; // exhausted all attempts
}
