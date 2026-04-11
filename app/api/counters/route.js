/**
 * GET/POST /api/counters — Persistent key-value counter store for the Slack bot.
 *
 * Used by lib/geminiQuota.js to track the Gemini free-tier call count across
 * PM2 restarts. The bot cannot import Supabase directly (no SUPABASE_URL on VM),
 * so it calls this Vercel endpoint instead.
 *
 * Auth: x-api-secret header (same pattern as /api/costs/log)
 *
 * GET  /api/counters?key=<key>       → { key, value, meta }
 * POST /api/counters/increment       body: { key, meta? }   → { key, value }
 * POST /api/counters/reset           body: { key, value?, meta? } → { key, value }
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
  const path = url.pathname;  // e.g. /api/counters/increment or /api/counters/reset
  const body = await req.json().catch(() => ({}));
  const { key, meta } = body;

  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  if (path.endsWith('/increment')) {
    // Atomic increment via upsert: insert with value=1 or update value = value + 1
    const { data: existing } = await supabase
      .from('bot_counters')
      .select('value')
      .eq('key', key)
      .single();

    const newValue = (existing?.value ?? 0) + 1;
    await supabase.from('bot_counters').upsert({
      key,
      value:      newValue,
      meta:       meta ?? existing?.meta ?? null,
      updated_at: new Date().toISOString(),
    });

    return NextResponse.json({ key, value: newValue });
  }

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

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
