/**
 * GET /api/calendar/auth
 * Starts Google Calendar OAuth. Visit this URL once in a browser to authorise.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID      — same as app login
 *   GOOGLE_CLIENT_SECRET  — same as app login
 *   GOOGLE_CALENDAR_REDIRECT_URI — e.g. https://project-os-beta.vercel.app/api/calendar/callback
 *
 * Required Supabase table:
 *   CREATE TABLE calendar_tokens (
 *     user_id       text PRIMARY KEY,
 *     access_token  text NOT NULL,
 *     refresh_token text NOT NULL,
 *     expires_at    timestamptz NOT NULL,
 *     created_at    timestamptz DEFAULT now()
 *   );
 *
 * Setup steps:
 *   1. Google Cloud Console → APIs & Services → Library → enable Google Calendar API
 *   2. OAuth consent screen → Scopes → add https://www.googleapis.com/auth/calendar.events
 *   3. Credentials → your OAuth client → add redirect URI:
 *        https://project-os-beta.vercel.app/api/calendar/callback
 *   4. Add GOOGLE_CALENDAR_REDIRECT_URI to Vercel env vars
 *   5. Visit https://project-os-beta.vercel.app/api/calendar/auth in browser
 *   6. Sign in with the Google account that owns the calendars
 */

import { NextResponse } from 'next/server';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export async function GET() {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'GOOGLE_CLIENT_ID or GOOGLE_CALENDAR_REDIRECT_URI not set' },
      { status: 500 },
    );
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',   // get refresh token
    prompt:        'consent',   // always show consent so refresh token is issued
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  );
}
