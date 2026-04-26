/**
 * POST /api/login
 *
 * Validates the password against APP_SECRET. On match, generates a fresh
 * random session token (64-char hex), persists it to session_tokens with a
 * 30-day expiry, and sets it as an HttpOnly cookie.
 *
 * Body: { password: string }
 * Response: { ok: true } or 401
 */

import { NextResponse } from 'next/server';
import {
  createSession,
  sessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '../../../lib/auth.js';

export async function POST(req) {
  const { password } = await req.json().catch(() => ({}));

  if (!password || password !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  const { token } = await createSession();

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return res;
}
