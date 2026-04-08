/**
 * Google Calendar OAuth scaffold
 *
 * Required env vars (not yet set):
 *   GOOGLE_CLIENT_ID      — same as used for app login
 *   GOOGLE_CLIENT_SECRET  — same as used for app login
 *   GOOGLE_CALENDAR_REDIRECT_URI — e.g. https://project-os-beta.vercel.app/api/calendar/callback
 *
 * Required Supabase table (not yet created):
 *   calendar_tokens (
 *     user_id      uuid references users(id),
 *     access_token text,
 *     refresh_token text,
 *     expires_at   timestamptz,
 *     created_at   timestamptz default now()
 *   )
 *
 * OAuth scopes needed:
 *   https://www.googleapis.com/auth/calendar.events  — create/read events
 *
 * Flow:
 *   1. GET /api/calendar/auth      → redirects user to Google consent screen
 *   2. GET /api/calendar/callback  → exchanges code for tokens, stores in DB
 *   3. POST /api/calendar/event    → creates an event using stored refresh token
 *
 * Hook-in point in bot.js (reminder intent):
 *   When intent=reminder and CALENDAR_ENABLED=true, after saving to personal project,
 *   also POST /api/calendar/event with { title, datetime, userId }.
 *
 * TODO: implement when ready to connect calendar
 */

import { NextResponse } from 'next/server';

// ── Placeholder: not yet implemented ─────────────────────────────────────────
export async function GET() {
  return NextResponse.json(
    { error: 'Google Calendar integration not yet enabled. Set CALENDAR_ENABLED=true and complete OAuth setup.' },
    { status: 501 },
  );
}
