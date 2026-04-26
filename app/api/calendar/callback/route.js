/**
 * GET /api/calendar/callback
 * OAuth callback — exchanges the code for tokens and stores them.
 * Google redirects here after the user approves the consent screen.
 */

import { storeTokens }  from '../../../../lib/calendar.js';
import { ok, fail }     from '../../../../lib/apiResponse.js';
import { ValidationError, UpstreamError } from '../../../../lib/errors.js';
import { log }          from '../../../../lib/log.js';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const code  = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) throw new ValidationError(`Google OAuth error: ${error}`);
    if (!code)  throw new ValidationError('No code in callback');

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
      log.error('calendar:callback', 'token_exchange_failed', { detail: data });
      throw new UpstreamError('Token exchange failed');
    }

    await storeTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
    });

    return ok({
      ok:      true,
      message: 'Google Calendar connected. Bot can now create calendar events.',
    });
  } catch (err) {
    log.error('calendar:callback', 'failed', { err: err.message });
    return fail(err);
  }
}
