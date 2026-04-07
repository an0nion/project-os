/**
 * Multi-Provider API Client
 * Single entry point for all AI calls — routes to Anthropic, Google, or DeepSeek.
 *
 * Exports:
 *   callModel(modelKey, opts)                    — call a specific model
 *   callModelWithFallback(primary, fallback, opts) — call with automatic fallback
 */

import { MODELS, PROVIDERS } from './models.js';

// ── Gemini free-tier tracker (in-memory; resets daily) ────────────────────────
let _geminiCallsToday = 0;
let _geminiResetDate  = new Date().toDateString();
const GEMINI_FREE_LIMIT = 1000;

function geminiQuotaRemaining() {
  if (new Date().toDateString() !== _geminiResetDate) {
    _geminiCallsToday = 0;
    _geminiResetDate  = new Date().toDateString();
  }
  return GEMINI_FREE_LIMIT - _geminiCallsToday;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call any model from any provider through one function.
 *
 * @param {string} modelKey  - Key from lib/models.js
 * @param {{ system?, messages, maxTokens? }} opts
 * @returns {Promise<{ text, usage, model, provider, cached, modelKey }>}
 */
export async function callModel(modelKey, { system, messages, maxTokens }) {
  const config = MODELS[modelKey];
  if (!config) throw new Error(`Unknown model: ${modelKey}`);

  const apiKey = process.env[PROVIDERS[config.provider].envKey];
  if (!apiKey) throw new Error(`Missing env var: ${PROVIDERS[config.provider].envKey}`);

  const effectiveMax = maxTokens || config.maxOutput || 1500;

  try {
    let result;
    switch (config.provider) {
      case 'google':
        result = await _callGoogle(config, apiKey, system, messages, effectiveMax);
        _geminiCallsToday++;
        break;
      case 'deepseek':
        result = await _callDeepSeek(config, apiKey, system, messages, effectiveMax);
        break;
      case 'anthropic':
        result = await _callAnthropic(config, apiKey, system, messages, effectiveMax);
        break;
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
    return { ...result, modelKey };
  } catch (err) {
    err.modelKey  = modelKey;
    err.provider  = config.provider;
    throw err;
  }
}

/**
 * Call with automatic fallback.
 * Tries primaryKey first; if it fails (or Gemini quota exhausted) tries fallbackKey.
 *
 * @param {string} primaryKey
 * @param {string} fallbackKey
 * @param {{ system?, messages, maxTokens? }} params
 * @returns {Promise<{ text, usage, model, provider, cached, modelKey }>}
 */
export async function callModelWithFallback(primaryKey, fallbackKey, params) {
  // Auto-downgrade Gemini to fallback if quota exhausted
  const resolvedPrimary = (primaryKey === 'gemini-flash' && geminiQuotaRemaining() <= 0)
    ? fallbackKey
    : primaryKey;

  try {
    return await callModel(resolvedPrimary, params);
  } catch (err) {
    console.warn(`[AI] ${resolvedPrimary} failed (${err.message}), falling back to ${fallbackKey}`);
    return await callModel(fallbackKey, params);
  }
}

// Backward-compat alias used by router.js and other early callers
export const chatWithModel = (modelKey, opts) => {
  // Map old keys to new keys
  const keyMap = { 'gemini-flash-lite': 'gemini-flash', 'deepseek-v3': 'deepseek-chat' };
  return callModel(keyMap[modelKey] ?? modelKey, opts);
};


// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function _callAnthropic(config, apiKey, system, messages, maxTokens) {
  const body = {
    model:      config.model,
    max_tokens: maxTokens,
    messages,
  };

  // Prompt caching: mark system prompt as cacheable.
  // Cached tokens cost 10% of normal input rate = 90% savings on repeated calls.
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),   // Opus can be slow
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    text:     data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '',
    usage:    data.usage,
    model:    config.model,
    provider: 'anthropic',
    cached:   (data.usage?.cache_read_input_tokens ?? 0) > 0,
  };
}

async function _callGoogle(config, apiKey, system, messages, maxTokens) {
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    text:     data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '',
    usage: {
      input_tokens:  data.usageMetadata?.promptTokenCount     || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    model:    config.model,
    provider: 'google',
    cached:   false,
  };
}

async function _callDeepSeek(config, apiKey, system, messages, maxTokens) {
  const dsMessages = [];
  if (system) dsMessages.push({ role: 'system', content: system });
  dsMessages.push(...messages);

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       config.model,
      messages:    dsMessages,
      max_tokens:  maxTokens,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    text:     data.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens:  data.usage?.prompt_tokens     || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
    model:    config.model,
    provider: 'deepseek',
    cached:   (data.usage?.prompt_cache_hit_tokens ?? 0) > 0,
  };
}
