/**
 * Unified cost logger — single entry point for all AI cost tracking.
 *
 * Replaces the two parallel paths that existed historically:
 *   - lib/costTracker.js (direct supabase write, used in Vercel routes)
 *   - lib/vmCostLogger.js (HTTP POST to /api/costs/log, used on the Slack VM)
 *
 * Routing is automatic and env-aware:
 *   - SUPABASE_SERVICE_KEY present → write to supabase directly (server context).
 *   - Otherwise → POST to ${APP_URL}/api/costs/log (VM / restricted context).
 *
 * Cost logging is best-effort: failures are logged via console.error but never
 * thrown. This module must NEVER block user-visible work.
 */

import { MODELS } from './models.js';

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
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  const normalTokens = (usage.input_tokens ?? 0) - cachedTokens;
  const inputCost    = (normalTokens / 1_000_000 * model.inputCost) + (cachedTokens / 1_000_000 * model.inputCost * 0.1);
  const outputCost   = (usage.output_tokens ?? 0) / 1_000_000 * model.outputCost;

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
 * Normalise meta — accepts either the full object form or a bare reason string
 * (the legacy vmCostLogger signature). This lets callers migrate at their own
 * pace without breaking.
 */
function normaliseMeta(meta) {
  if (typeof meta === 'string') return { reason: meta };
  return meta ?? {};
}

/**
 * Direct supabase write. Lazy-imports supabase so VM contexts that lack
 * SUPABASE_URL never load the client at module init time.
 */
async function logViaSupabase(modelKey, usage, meta) {
  const model = MODELS[modelKey];
  if (!model) return;

  const cost = calculateCost(modelKey, usage);

  const { supabase } = await import('./supabase.js');
  await supabase.from('cost_log').insert({
    model:         model.model,
    provider:      model.provider,
    tier:          model.tier,
    input_tokens:  usage?.input_tokens  ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cost_usd:      cost.totalCost,
    cached:        meta.cached     ?? false,
    project_key:   meta.projectKey ?? null,
    reason:        meta.reason     ?? null,
    latency_ms:    meta.latencyMs  ?? null,
  });
}

/**
 * HTTP POST to the cost log endpoint (used from the Slack VM where supabase
 * cannot be imported directly).
 */
async function logViaApi(modelKey, usage, meta) {
  if (!process.env.APP_URL) return;
  // TODO (Unit 3): switch to COST_LOG_SECRET once introduced; APP_SECRET is the
  // current shared secret used by the cost log endpoint.
  const secret = process.env.COST_LOG_SECRET || process.env.APP_SECRET;

  const res = await fetch(`${process.env.APP_URL}/api/costs/log`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
    body:    JSON.stringify({
      modelKey,
      usage,
      reason:     meta.reason     ?? null,
      projectKey: meta.projectKey ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`cost-log endpoint returned ${res.status}`);
  }
}

/**
 * Log a completed API call. Best-effort, never throws.
 *
 * @param {string} modelKey
 * @param {object} usage   - { input_tokens, output_tokens, cache_read_input_tokens? }
 * @param {object|string} [meta] - { projectKey?, cached?, reason?, latencyMs? } or bare reason string
 */
export async function logCost(modelKey, usage, meta = {}) {
  if (!modelKey || !usage) return;
  const normalisedMeta = normaliseMeta(meta);

  try {
    if (process.env.SUPABASE_SERVICE_KEY) {
      await logViaSupabase(modelKey, usage, normalisedMeta);
    } else {
      await logViaApi(modelKey, usage, normalisedMeta);
    }
  } catch (err) {
    console.error('[costLog]', err?.message ?? err);
  }
}
