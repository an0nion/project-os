/**
 * GET/POST /api/counters — Persistent key-value counter store for the Slack bot.
 *
 * Used by lib/geminiQuota.js to track the Gemini free-tier call count across
 * PM2 restarts. The bot cannot import Supabase directly (no SUPABASE_URL on VM),
 * so it calls this Vercel endpoint instead.
 *
 * Auth: x-api-secret header (same pattern as /api/costs/log)
 *
 * GET  /api/counters?key=<key>    → { key, value, meta }
 *
 * POST /api/counters              body: { key|name, delta, meta? } → { key, value }
 *   Atomic increment via Postgres RPC (UPDATE ... SET value = value + delta).
 *
 * POST /api/counters              body: { key|name, count, meta? } → { key, value }
 *   DEPRECATED overwrite-with-client-value path. Logs a deprecation warning.
 *
 * POST /api/counters/increment    body: { key, meta? } → { key, value }   (legacy alias for delta=1)
 * POST /api/counters/reset        body: { key, value?, meta? } → { key, value }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

function authCheck(req) {
  const secret = req.headers.get('x-api-secret');
  return secret && secret === process.env.APP_SECRET;
}

export async function GET(req) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  const { data } = await supabase
    .from('bot_counters')
    .select('key, value, meta')
    .eq('key', key)
    .single();

  return NextResponse.json({ key, value: data?.value ?? 0, meta: data?.meta ?? null });
}

export async function POST(req) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url  = new URL(req.url);
  const path = url.pathname;
  const body = await req.json().catch(() => ({}));
  const key  = body.key ?? body.name;
  const meta = body.meta ?? null;

  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  // ── /api/counters/reset (overwrite) ────────────────────────────────────────
  if (path.endsWith('/reset')) {
    const resetValue = body.value ?? 0;
    await supabase.from('bot_counters').upsert({
      key,
      value:      resetValue,
      meta:       meta ?? null,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ key, value: resetValue });
  }

  // ── /api/counters/increment (legacy alias for delta=1) ────────────────────
  if (path.endsWith('/increment')) {
    const value = await _atomicIncrement(key, 1, meta);
    return NextResponse.json({ key, value });
  }

  // ── /api/counters atomic increment ────────────────────────────────────────
  if (typeof body.delta === 'number') {
    const value = await _atomicIncrement(key, body.delta, meta);
    return NextResponse.json({ key, value });
  }

  // ── Backward-compat: overwrite with client's count ────────────────────────
  if (typeof body.count === 'number') {
    console.warn('[counters] DEPRECATED overwrite path used for key=%s — switch to { delta }', key);
    await supabase.from('bot_counters').upsert({
      key,
      value:      body.count,
      meta:       meta ?? null,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ key, value: body.count });
  }

  return NextResponse.json({ error: 'Unknown action — supply delta or count' }, { status: 400 });
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

  // RPC missing or errored — fall back to non-atomic path so the route still works.
  console.warn('[counters] RPC increment_bot_counter failed (%s) — falling back', error?.message);
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
