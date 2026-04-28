/**
 * GET /api/calendar/auth
 * Starts Google Calendar OAuth. Visit this URL once in a browser to authorise.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_CALENDAR_REDIRECT_URI
 *
 * Returns a redirect to Google, NOT JSON, so we don't use ok()/fail() here.
 */

import { NextResponse } from 'next/server';
import { fail }         from '../../../../lib/apiResponse.js';
import { AppError }     from '../../../../lib/errors.js';
import { log }          from '../../../../lib/log.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export async function GET() {
  try {
    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new AppError('CONFIG', 'GOOGLE_CLIENT_ID or GOOGLE_CALENDAR_REDIRECT_URI not set', 500);
    }

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         SCOPES,
      access_type:   'offline',
      prompt:        'consent',
    });

    return NextResponse.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    );
  } catch (err) {
    log.error('calendar:auth', 'failed', { err: err.message });
    return fail(err);
  }
}
