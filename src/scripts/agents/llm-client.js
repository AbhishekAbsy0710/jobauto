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

// ── Provider configs ────────────────────────────────────────────────────────────
const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    call: async (systemPrompt, userPrompt, _model) => {
      // Gemini uses its own REST format (not OpenAI-compatible)
      return await callGemini(systemPrompt, userPrompt);
    },
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
    keyEnv: 'CEREBRAS_API_KEY',
  },
  sambanova: {
    name: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1/chat/completions',
    keyEnv: 'SAMBANOVA_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
  },
};

// Ordered fallback chain — each model cascades to the NEXT one
// Format: { provider, model, label, quota }
const MODEL_CASCADE = [
  { provider: 'gemini',     model: 'gemini-2.0-flash',                           label: 'Gemini 2.0 Flash',        quota: '1500 req/day' },
  { provider: 'groq',       model: 'llama-3.3-70b-versatile',                    label: 'Groq Llama 3.3 70b',      quota: '100k TPD' },
  { provider: 'cerebras',   model: 'gpt-oss-120b',                               label: 'Cerebras GPT-OSS 120b',   quota: '1M tok/day' },
  { provider: 'groq',       model: 'meta-llama/llama-4-scout-17b-16e-instruct',  label: 'Groq Scout 17b',          quota: '500k TPD' },
  { provider: 'sambanova',  model: 'Meta-Llama-3.3-70B-Instruct',                label: 'SambaNova Llama 70b',     quota: '$5 free' },
  { provider: 'groq',       model: 'mixtral-8x7b-32768',                         label: 'Groq Mixtral 8x7b',       quota: '500k TPD' },
  { provider: 'cerebras',   model: 'qwen-3-235b-a22b-instruct-2507',             label: 'Cerebras Qwen3 235b',     quota: '1M tok/day' },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash:free',             label: 'OpenRouter DeepSeek V4',   quota: '50 req/day' },
  { provider: 'cerebras',   model: 'llama3.1-8b',                                label: 'Cerebras Llama 8b',       quota: '1M tok/day' },
  { provider: 'groq',       model: 'llama-3.1-8b-instant',                       label: 'Groq Llama 8b',           quota: '500k TPD' },
  { provider: 'openrouter', model: 'qwen/qwen3-coder:free',                      label: 'OpenRouter Qwen3 Coder',  quota: '50 req/day' },
  { provider: 'sambanova',  model: 'DeepSeek-V3.1',                              label: 'SambaNova DeepSeek V3.1', quota: '$5 free' },
];

function getNextModelIndex(currentIdx) {
  return currentIdx + 1 < MODEL_CASCADE.length ? currentIdx + 1 : -1;
}

// Generic OpenAI-compatible API call
async function callOpenAICompatible(provider, model, systemPrompt, userPrompt) {
  const config = PROVIDERS[provider];
  if (!config || !config.baseUrl) return null;
  
  const apiKey = process.env[config.keyEnv];
  if (!apiKey) return null; // Skip if no key configured
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  // OpenRouter requires extra headers
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/AbhishekAbsy0710/jobauto';
    headers['X-Title'] = 'JobAuto';
  }

  const res = await fetch(config.baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
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
    const errText = await res.text().catch(() => '');
    console.log(`  ⚠️ ${config.name} API Error (${model}): ${res.status} - ${errText.substring(0, 200)}`);
    return { error: true, status: res.status, errText };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  console.log(`  ✅ ${config.name} ${model.split('/').pop()} responded (${content.length} chars)`);
  return { content };
}

export async function callGroq(systemPrompt, userPrompt, model = null, _depth = 0) {
  // Recursion guard
  if (_depth > MODEL_CASCADE.length + 2) {
    console.log(`  ⚠️ Max cascade depth reached — returning empty`);
    return '{}';
  }

  // Find starting index in cascade
  let startIdx = 0;
  if (model) {
    // Legacy callers pass model string — find it in the cascade
    if (model === '__gemini__') {
      startIdx = 0; // Gemini is first
    } else {
      const idx = MODEL_CASCADE.findIndex(m => m.model === model);
      if (idx !== -1) startIdx = idx;
    }
  }

  // Walk the cascade from startIdx
  for (let i = startIdx; i < MODEL_CASCADE.length; i++) {
    const entry = MODEL_CASCADE[i];
    
    try {
      if (entry.provider === 'gemini') {
        const result = await callGemini(systemPrompt, userPrompt);
        if (result && result !== '{}') return result;
        console.log(`  🔄 ${entry.label} failed → trying next...`);
        continue;
      }

      const result = await callOpenAICompatible(entry.provider, entry.model, systemPrompt, userPrompt);
      
      if (!result) {
        // No API key for this provider — skip silently
        continue;
      }
      
      if (result.error) {
        // Rate limit — cascade to next
        if (result.status === 429) {
          const nextIdx = getNextModelIndex(i);
          if (nextIdx !== -1) {
            // Check if TPM (per-minute) — retry same model with backoff
            if (result.errText?.includes('TPM')) {
              const waitMatch = result.errText.match(/try again in ([\d\.]+)s/);
              const waitTime = waitMatch ? (parseFloat(waitMatch[1]) * 1000) + 1000 : 15000;
              console.log(`  ⏳ TPM limit hit. Waiting ${Math.round(waitTime/1000)}s before retry...`);
              await new Promise(r => setTimeout(r, waitTime));
              // Retry same model
              const retry = await callOpenAICompatible(entry.provider, entry.model, systemPrompt, userPrompt);
              if (retry && !retry.error) return retry.content;
            }
            console.log(`  🔄 ${entry.label} rate limited → trying ${MODEL_CASCADE[nextIdx].label}...`);
          }
          continue;
        }
        // Model not found / decommissioned — skip
        if (result.status === 400 || result.status === 404) {
          continue;
        }
        // Request too large — skip
        if (result.status === 413) {
          continue;
        }
        continue;
      }

      return result.content;
    } catch (err) {
      console.log(`  ⚠️ ${entry.label} network error: ${err.message}`);
      continue;
    }
  }

  console.log(`  ⚠️ All AI models exhausted. Applying with base resume...`);
  return '{}';
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
