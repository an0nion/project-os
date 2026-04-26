/**
 * GET/POST /api/counters — Persistent key-value counter store for the Slack bot.
 *
 * Used by lib/geminiQuota.js to track the Gemini free-tier call count across
 * PM2 restarts. The bot cannot import Supabase directly (no SUPABASE_URL on VM),
 * so it calls this Vercel endpoint instead.
 *
 * Auth: x-api-secret header (same pattern as /api/costs/log)
 *
 * GET  /api/counters?key=<key>    → { ok: true, data: { key, value, meta } }
 *
 * POST /api/counters              body: { key|name, delta, meta? } → { ok: true, data: { key, value } }
 *   Atomic increment via Postgres RPC (UPDATE ... SET value = value + delta).
 *
 * POST /api/counters              body: { key|name, count, meta? } → { ok: true, data: { key, value } }
 *   DEPRECATED overwrite-with-client-value path. Logs a deprecation warning.
 *
 * POST /api/counters/increment    body: { key, meta? } → { ok: true, data: { key, value } }   (legacy alias for delta=1)
 * POST /api/counters/reset        body: { key, value?, meta? } → { ok: true, data: { key, value } }
 */

import { supabase }     from '../../../lib/supabase.js';
import { ok, fail }     from '../../../lib/apiResponse.js';
import { CountersPost } from '../../../lib/schemas.js';
import { ValidationError, AuthError } from '../../../lib/errors.js';
import { log }          from '../../../lib/log.js';

function authCheck(req) {
  const secret = req.headers.get('x-api-secret');
  return secret && secret === process.env.APP_SECRET;
}

export async function GET(req) {
  try {
    if (!authCheck(req)) throw new AuthError();

    const key = new URL(req.url).searchParams.get('key');
    if (!key) throw new ValidationError('key required');

    const { data } = await supabase
      .from('bot_counters')
      .select('key, value, meta')
      .eq('key', key)
      .single();

    return ok({ key, value: data?.value ?? 0, meta: data?.meta ?? null });
  } catch (err) {
    log.error('counters', 'get_failed', { err: err.message });
    return fail(err);
  }
}

export async function POST(req) {
  try {
    if (!authCheck(req)) throw new AuthError();

    const url  = new URL(req.url);
    const path = url.pathname;

    let body;
    try { body = await req.json().catch(() => ({})); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = CountersPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { delta, count, value, meta: metaRaw } = parsed.data;
    const key  = parsed.data.key ?? parsed.data.name;
    const meta = metaRaw ?? null;

    // ── /api/counters/reset (overwrite) ────────────────────────────────────
    if (path.endsWith('/reset')) {
      const resetValue = value ?? 0;
      await supabase.from('bot_counters').upsert({
        key,
        value:      resetValue,
        meta,
        updated_at: new Date().toISOString(),
      });
      return ok({ key, value: resetValue });
    }

    // ── /api/counters/increment (legacy alias for delta=1) ────────────────
    if (path.endsWith('/increment')) {
      const next = await _atomicIncrement(key, 1, meta);
      return ok({ key, value: next });
    }

    // ── /api/counters atomic increment ────────────────────────────────────
    if (typeof delta === 'number') {
      const next = await _atomicIncrement(key, delta, meta);
      return ok({ key, value: next });
    }

    // ── Backward-compat: overwrite with client's count ────────────────────
    if (typeof count === 'number') {
      log.warn('counters', 'deprecated_overwrite', { key });
      await supabase.from('bot_counters').upsert({
        key,
        value:      count,
        meta,
        updated_at: new Date().toISOString(),
      });
      return ok({ key, value: count });
    }

    throw new ValidationError('Unknown action — supply delta, count, or use /increment, /reset');
  } catch (err) {
    log.error('counters', 'post_failed', { err: err.message });
    return fail(err);
  }
}

/**
 * Atomic increment via Postgres RPC.
 * Falls back to read-modify-write upsert if the RPC isn't deployed yet.
 */
async function _atomicIncrement(key, delta, meta) {
  const { data, error } = await supabase.rpc('increment_bot_counter', {
    p_key:   key,
    p_delta: delta,
    p_meta:  meta,
  });
  if (!error && typeof data === 'number') return data;
  if (!error && data?.value != null)      return data.value;

  log.warn('counters', 'rpc_fallback', { err: error?.message });
  const { data: existing } = await supabase
    .from('bot_counters')
    .select('value, meta')
    .eq('key', key)
    .single();
  const newValue = (existing?.value ?? 0) + delta;
  await supabase.from('bot_counters').upsert({
    key,
    value:      newValue,
    meta:       meta ?? existing?.meta ?? null,
    updated_at: new Date().toISOString(),
  });
  return newValue;
}
