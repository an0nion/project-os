/**
 * GET /api/calendar/callback
 * OAuth callback — exchanges the code for tokens and stores them.
 * Google redirects here after the user approves the consent screen.
 */

import { NextResponse } from 'next/server';
import { storeTokens }  from '../../../../lib/calendar.js';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.json({ error: `Google OAuth error: ${error}` }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: 'No code in callback' }, { status: 400 });
  }

  // Exchange code for tokens
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_CALENDAR_REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });

  const data = await res.json();
  if (!data.access_token || !data.refresh_token) {
    return NextResponse.json(
      { error: 'Token exchange failed', detail: data },
      { status: 500 },
    );
  }

  await storeTokens({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in,
  });

  return NextResponse.json({
    ok:      true,
    message: 'Google Calendar connected. Bot can now create calendar events.',
  });
}
