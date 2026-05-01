// ============================================
// Unified LLM Caller — Groq (cloud) / Ollama (local fallback)
// ============================================
import { loadConfig } from '../config.js';

/**
 * Call LLM with system + user prompts.
 * Auto-selects: GROQ_API_KEY present → Groq cloud, else → local Ollama.
 * Groq uses OpenAI-compatible API with llama-3.3-70b.
 */
export async function callLLM(systemPrompt, userPrompt, options = {}) {
  const config = loadConfig();
  const groqKey = config.groqApiKey;

  if (groqKey) {
    return callGroq(groqKey, systemPrompt, userPrompt, options);
  } else {
    return callOllama(config, systemPrompt, userPrompt, options);
  }
}

// ============================================
// GROQ — Free, fast, llama-3.3-70b
// ============================================
async function callGroq(apiKey, systemPrompt, userPrompt, options = {}) {
  const model = options.model || 'llama-3.3-70b-versatile';
  console.log(`  🚀 Calling Groq (${model})...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 60000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens || 2000,
        response_format: options.json ? { type: 'json_object' } : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Groq ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;
    if (usage) {
      console.log(`  ✅ Groq: ${usage.prompt_tokens}+${usage.completion_tokens} tokens (${usage.total_time ? usage.total_time.toFixed(1) + 's' : 'done'})`);
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// OLLAMA — Local fallback for development
// ============================================
async function callOllama(config, systemPrompt, userPrompt, options = {}) {
  const url = `${config.ollamaBaseUrl}/api/chat`;
  console.log(`  🤖 Calling Ollama (${config.ollamaModel})...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 600000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 1500, num_ctx: 4096 },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama ${response.status}: ${text}`);
    }

    const data = await response.json();
    return data.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// HEALTH CHECK
// ============================================
export async function checkLLMHealth() {
  const config = loadConfig();
  const groqKey = config.groqApiKey;

  if (groqKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json();
        const models = (data.data || []).map(m => m.id);
        return { provider: 'groq', healthy: true, models: models.slice(0, 5), model: 'llama-3.3-70b-versatile' };
      }
      return { provider: 'groq', healthy: false, error: `HTTP ${response.status}` };
    } catch (e) {
      return { provider: 'groq', healthy: false, error: e.message };
    }
  }

  // Fallback: check Ollama
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json();
      const models = (data.models || []).map(m => m.name);
      const hasModel = models.some(m => m.includes(config.ollamaModel.split(':')[0]));
      return { provider: 'ollama', healthy: true, models, hasModel, requiredModel: config.ollamaModel };
    }
    return { provider: 'ollama', healthy: false };
  } catch {
    return { provider: 'ollama', healthy: false };
  }
}
