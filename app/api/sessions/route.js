/**
 * /api/sessions — Slack bot pending conversation state store.
 *
 * The bot cannot import Supabase directly (no SUPABASE_URL on the Oracle VM),
 * so lib/pendingStore.js calls these endpoints to persist/restore session state
 * across PM2 restarts.
 *
 * Auth: x-api-secret header via lib/auth.js (kind: 'apiSecret').
 *
 * NOTE: this table (`bot_sessions`) is unrelated to browser session cookies.
 * Browser sessions live in `session_tokens` and are managed by /api/login,
 * /api/logout, and lib/auth.js.
 *
 * GET    /api/sessions              → { sessions: [{ user_id, state }] }  (all non-expired)
 * GET    /api/sessions?userId=<id>  → { state: object | null }
 * POST   /api/sessions              body: { userId, state, ttlSeconds? }   → { ok: true }
 * DELETE /api/sessions?userId=<id>  → { ok: true }
 */

import { NextResponse }                  from 'next/server';
import { supabase }                      from '../../../lib/supabase.js';
import { requireAuth, unauthorizedBody } from '../../../lib/auth.js';

async function gate(req) {
  const r = await requireAuth(req, { kind: 'apiSecret' });
  if (!r.ok) return NextResponse.json(unauthorizedBody(), { status: 401 });
  return null;
}

export async function GET(req) {
  const fail = await gate(req); if (fail) return fail;

  const userId = new URL(req.url).searchParams.get('userId');
  const now    = new Date().toISOString();

  if (userId) {
    const { data } = await supabase
      .from('bot_sessions')
      .select('state')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .single();

    return NextResponse.json({ state: data?.state ?? null });
  }

  const { data } = await supabase
    .from('bot_sessions')
    .select('user_id, state')
    .gt('expires_at', now);

  return NextResponse.json({ sessions: data ?? [] });
}

export async function POST(req) {
  const fail = await gate(req); if (fail) return fail;

  const { userId, state, ttlSeconds = 3600 } = await req.json().catch(() => ({}));
  if (!userId || !state) {
    return NextResponse.json({ error: 'userId and state required' }, { status: 400 });
  }

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
  const fail = await gate(req); if (fail) return fail;

  const userId = new URL(req.url).searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  await supabase.from('bot_sessions').delete().eq('user_id', userId);
  return NextResponse.json({ ok: true });
}
