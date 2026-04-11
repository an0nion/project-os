/**
 * /api/sessions — Slack bot pending conversation state store.
 *
 * The bot cannot import Supabase directly (no SUPABASE_URL on the Oracle VM),
 * so lib/pendingStore.js calls these endpoints to persist/restore session state
 * across PM2 restarts.
 *
 * Auth: x-api-secret header (same pattern as /api/costs/log)
 *
 * GET    /api/sessions              → { sessions: [{ user_id, state }] }  (all non-expired)
 * GET    /api/sessions?userId=<id>  → { state: object | null }
 * POST   /api/sessions              body: { userId, state, ttlSeconds? }   → { ok: true }
 * DELETE /api/sessions?userId=<id>  → { ok: true }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

function authCheck(req) {
  const secret = req.headers.get('x-api-secret');
  return secret && secret === process.env.APP_SECRET;
}

export async function GET(req) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = new URL(req.url).searchParams.get('userId');
  const now    = new Date().toISOString();

  if (userId) {
    // Single session lookup
    const { data } = await supabase
      .from('bot_sessions')
      .select('state')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .single();

    return NextResponse.json({ state: data?.state ?? null });
  }

  // Bulk hydration — return all non-expired sessions
  const { data } = await supabase
    .from('bot_sessions')
    .select('user_id, state')
    .gt('expires_at', now);

  return NextResponse.json({ sessions: data ?? [] });
}

export async function POST(req) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId, state, ttlSeconds = 3600 } = await req.json().catch(() => ({}));
  if (!userId || !state) return NextResponse.json({ error: 'userId and state required' }, { status: 400 });

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  await supabase.from('bot_sessions').upsert({
    user_id:    userId,
    state,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = new URL(req.url).searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  await supabase.from('bot_sessions').delete().eq('user_id', userId);

  return NextResponse.json({ ok: true });
}
