/**
 * POST /api/logout
 *
 * Reads the session cookie, deletes the matching session_tokens row, and
 * clears the cookie. Idempotent — calling without a cookie still returns 200.
 */

import { NextResponse } from 'next/server';
import {
  destroySession,
  sessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '../../../lib/auth.js';

export async function POST(req) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    try {
      await destroySession(token);
    } catch (err) {
      // Logout should always succeed for the caller; the cookie is cleared
      // either way and the row will lapse via expires_at.
      console.error('[logout] destroySession failed:', err?.message ?? err);
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
