/**
 * VM-safe cost logger — fire-and-forget fetch to /api/costs/log.
 *
 * The Slack bot runs on Oracle Cloud VM where supabase cannot be imported
 * directly (SUPABASE_URL may not be in VM .env, and importing it crashes the
 * process at startup). This module uses a plain HTTP call to the Vercel API
 * instead, which proxies to Supabase server-side.
 *
 * Usage:
 *   import { logCostViaApi } from '../lib/vmCostLogger.js';
 *   logCostViaApi(result.modelKey, result.usage, 'reason_string');
 *
 * Non-fatal — if the call fails (no APP_URL, no usage, network error), it
 * silently discards. The bot should never fail because of cost tracking.
 */

/**
 * @param {string} modelKey   - Key from lib/models.js (e.g. 'gemini-flash')
 * @param {object} usage      - { input_tokens, output_tokens, ... }
 * @param {string} reason     - Human-readable label for this call (e.g. 'intent_classification')
 */
export function logCostViaApi(modelKey, usage, reason) {
  if (!process.env.APP_URL || !usage) return;
  fetch(`${process.env.APP_URL}/api/costs/log`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
    body:    JSON.stringify({ modelKey, usage, reason }),
  }).catch(err => console.error('[vmCostLogger]', err.message));
}
