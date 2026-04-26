/**
 * Multi-Provider API Client
 * Single entry point for all AI calls — routes to Anthropic, Google, or DeepSeek.
 *
 * Exports:
 *   callModel(modelKey, opts)                     — call a specific model
 *   callModelWithFallback(primary, fallback, opts) — call with automatic fallback
 *   chatWithModel(modelKey, opts)                 — backward-compat alias
 *
 * This file is a thin router. Provider HTTP shapes live in lib/providers/*.
 */

import { MODELS, PROVIDERS }                  from './models.js';
import { quotaRemaining, incrementQuota }     from './geminiQuota.js';
import { isOpen, withBreaker }                from './circuitBreaker.js';
import { call as callAnthropic }              from './providers/anthropic.js';
import { call as callGoogle }                 from './providers/google.js';
import { call as callDeepSeek }               from './providers/deepseek.js';

// Provider registry — keep in step with the modules above
const PROVIDER_FNS = {
  anthropic: callAnthropic,
  google:    callGoogle,
  deepseek:  callDeepSeek,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call any model from any provider through one function.
 *
 * @param {string} modelKey  - Key from lib/models.js
 * @param {{ system?, messages, maxTokens?, signal? }} opts
 * @returns {Promise<{ text, usage, model, provider, cached, modelKey }>}
 */
export async function callModel(modelKey, { system, messages, maxTokens, signal } = {}) {
  const config = MODELS[modelKey];
  if (!config) throw new Error(`Unknown model: ${modelKey}`);

  const providerInfo = PROVIDERS[config.provider];
  if (!providerInfo) throw new Error(`Unknown provider: ${config.provider}`);

  const apiKey = process.env[providerInfo.envKey];
  if (!apiKey) throw new Error(`Missing env var: ${providerInfo.envKey}`);

  const providerFn = PROVIDER_FNS[config.provider];
  if (!providerFn) throw new Error(`No provider implementation for: ${config.provider}`);

  const effectiveMax = maxTokens || config.maxOutput || 1500;

  // For Google, await quota persistence BEFORE the call so concurrent VMs see the
  // increment. If persistence fails, geminiQuota pins remaining low and the next
  // callModelWithFallback() will downgrade to DeepSeek.
  if (config.provider === 'google') {
    await incrementQuota(process.env.APP_URL, process.env.APP_SECRET);
  }

  try {
    const result = await providerFn({ config, apiKey, system, messages, maxTokens: effectiveMax, signal });
    return { ...result, modelKey };
  } catch (err) {
    err.modelKey = modelKey;
    err.provider = config.provider;
    throw err;
  }
}

/**
 * Call with automatic fallback.
 * Tries primaryKey first; if it fails (or Gemini quota exhausted, or breaker open)
 * tries fallbackKey.
 *
 * @param {string} primaryKey
 * @param {string} fallbackKey
 * @param {{ system?, messages, maxTokens?, signal? }} params
 * @returns {Promise<{ text, usage, model, provider, cached, modelKey }>}
 */
export async function callModelWithFallback(primaryKey, fallbackKey, params) {
  const primaryConfig   = MODELS[primaryKey];
  const primaryProvider = primaryConfig?.provider;

  let resolvedPrimary = primaryKey;

  // Auto-downgrade Gemini to fallback if quota exhausted
  if (primaryKey === 'gemini-flash' && quotaRemaining() <= 0) {
    resolvedPrimary = fallbackKey;
  }

  // Skip primary entirely if its provider's circuit is open
  if (resolvedPrimary === primaryKey && primaryProvider && isOpen(primaryProvider)) {
    console.warn(`[AI] circuit open for ${primaryProvider}, skipping ${primaryKey} → ${fallbackKey}`);
    resolvedPrimary = fallbackKey;
  }

  if (resolvedPrimary === fallbackKey) {
    return _callThroughBreaker(fallbackKey, params);
  }

  try {
    return await _callThroughBreaker(resolvedPrimary, params);
  } catch (err) {
    console.warn(`[AI] ${resolvedPrimary} failed (${err.message}), falling back to ${fallbackKey}`);
    return _callThroughBreaker(fallbackKey, params);
  }
}

async function _callThroughBreaker(modelKey, params) {
  const provider = MODELS[modelKey]?.provider;
  if (!provider) return callModel(modelKey, params); // unknown model — let callModel throw
  return withBreaker(provider, () => callModel(modelKey, params));
}

// Backward-compat alias used by router.js and other early callers
export const chatWithModel = (modelKey, opts) => {
  // Map old keys to new keys
  const keyMap = { 'gemini-flash-lite': 'gemini-flash', 'deepseek-v3': 'deepseek-chat' };
  return callModel(keyMap[modelKey] ?? modelKey, opts);
};
