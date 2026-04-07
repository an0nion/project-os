/**
 * POST /api/login
 * Validates password and sets a session cookie.
 *
 * Body: { password: string }
 * Response: { ok: true } or 401
 */

import { NextResponse } from 'next/server';

export async function POST(req) {
  const { password } = await req.json();

  if (!password || password !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });

  res.cookies.set('session', process.env.APP_SECRET, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   60 * 60 * 24 * 30,   // 30 days
    path:     '/',
  });

  return res;
}
