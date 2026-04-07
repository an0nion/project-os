/**
 * Multi-Provider API Client
 * Single entry point for all AI calls — routes to Anthropic, Google, or DeepSeek.
 *
 * Features:
 *  - Prompt caching on all Anthropic calls (90% input savings on repeated prompts)
 *  - Gemini free-tier tracking with DeepSeek fallback
 *  - Unified response shape: { text, usage, model, provider, cached }
 */

import { MODELS } from './models.js';

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

function incrementGeminiCount() { _geminiCallsToday++; }

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a chat completion to any registered model.
 *
 * If modelKey is 'gemini-flash-lite' and the free quota is exhausted,
 * automatically falls back to 'deepseek-v3'.
 *
 * @param {string} modelKey  - Key from lib/models.js
 * @param {{ system, messages, maxTokens }} opts
 * @returns {Promise<{ text, usage, model, provider, cached, modelKey }>}
 */
export async function chatWithModel(modelKey, { system, messages, maxTokens = 1500 }) {
  // Free-tier fallback: Gemini → DeepSeek
  let resolvedKey = modelKey;
  if (modelKey === 'gemini-flash-lite' && geminiQuotaRemaining() <= 0) {
    resolvedKey = 'deepseek-v3';
  }

  const modelConfig = MODELS[resolvedKey];
  if (!modelConfig) throw new Error(`Unknown model: ${resolvedKey}`);

  const apiKey = process.env[_envKey(modelConfig.provider)];
  if (!apiKey) throw new Error(`Missing env var: ${_envKey(modelConfig.provider)}`);

  let result;
  switch (modelConfig.provider) {
    case 'anthropic':
      result = await _callAnthropic(modelConfig, apiKey, { system, messages, maxTokens });
      break;
    case 'google':
      result = await _callGoogle(modelConfig, apiKey, { system, messages, maxTokens });
      incrementGeminiCount();
      break;
    case 'deepseek':
      result = await _callDeepSeek(modelConfig, apiKey, { system, messages, maxTokens });
      break;
    default:
      throw new Error(`Unknown provider: ${modelConfig.provider}`);
  }

  return { ...result, modelKey: resolvedKey };
}

function _envKey(provider) {
  return { anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_AI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' }[provider];
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function _callAnthropic(modelConfig, apiKey, { system, messages, maxTokens }) {
  const body = {
    model:      modelConfig.model,
    max_tokens: maxTokens,
    messages,
  };

  // Prompt caching: mark system prompt as cacheable (saves 90% on input cost
  // for repeated prompts — the static system prompt is only charged 10% after
  // the first call in a session)
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':  'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    text:     data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '',
    usage:    data.usage,
    model:    modelConfig.model,
    provider: 'anthropic',
    cached:   (data.usage?.cache_read_input_tokens ?? 0) > 0,
  };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

async function _callGoogle(modelConfig, apiKey, { system, messages, maxTokens }) {
  // Convert Anthropic message format → Gemini format
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    text:     data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '',
    usage: {
      input_tokens:  data.usageMetadata?.promptTokenCount     || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    model:    modelConfig.model,
    provider: 'google',
    cached:   false,
  };
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────

async function _callDeepSeek(modelConfig, apiKey, { system, messages, maxTokens }) {
  const dsMessages = [];
  if (system) dsMessages.push({ role: 'system', content: system });
  dsMessages.push(...messages);

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       modelConfig.model,
      messages:    dsMessages,
      max_tokens:  maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    text:     data.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens:  data.usage?.prompt_tokens     || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
    model:    modelConfig.model,
    provider: 'deepseek',
    cached:   (data.usage?.prompt_cache_hit_tokens ?? 0) > 0,
  };
}
