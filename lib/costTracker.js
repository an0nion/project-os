/**
 * Cost Tracker — calculate and log API spend per call.
 * All costs in USD, stored with 6 decimal places.
 */

import { MODELS }   from './models.js';
import { supabase } from './supabase.js';

/**
 * Calculate cost for a single API call.
 *
 * @param {string} modelKey
 * @param {{ input_tokens: number, output_tokens: number, cache_read_input_tokens?: number }} usage
 * @returns {{ inputCost, outputCost, totalCost, model, tier }}
 */
export function calculateCost(modelKey, usage) {
  const model = MODELS[modelKey];
  if (!model || !usage) return { inputCost: 0, outputCost: 0, totalCost: 0, model: modelKey, tier: 0 };

  // Cached tokens are billed at 10% of normal input rate (Anthropic only)
  const cachedTokens   = usage.cache_read_input_tokens ?? 0;
  const normalTokens   = (usage.input_tokens ?? 0) - cachedTokens;
  const inputCost      = (normalTokens / 1_000_000 * model.inputCost) + (cachedTokens / 1_000_000 * model.inputCost * 0.1);
  const outputCost     = (usage.output_tokens ?? 0) / 1_000_000 * model.outputCost;

  const round6 = n => Math.round(n * 1_000_000) / 1_000_000;

  return {
    inputCost:  round6(inputCost),
    outputCost: round6(outputCost),
    totalCost:  round6(inputCost + outputCost),
    model:      model.model,
    tier:       model.tier,
  };
}

/**
 * Log a completed API call to the cost_log table (non-fatal).
 *
 * @param {string} modelKey
 * @param {object} usage
 * @param {{ projectKey?: string, cached?: boolean, reason?: string, latencyMs?: number }} meta
 */
export async function logCost(modelKey, usage, meta = {}) {
  const model = MODELS[modelKey];
  if (!model) return;

  const cost = calculateCost(modelKey, usage);

  await supabase.from('cost_log').insert({
    model:         model.model,
    provider:      model.provider,
    tier:          model.tier,
    input_tokens:  usage?.input_tokens  ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cost_usd:      cost.totalCost,
    cached:        meta.cached      ?? false,
    project_key:   meta.projectKey  ?? null,
    reason:        meta.reason      ?? null,
    latency_ms:    meta.latencyMs   ?? null,
  }).catch(() => {}); // non-fatal
}
