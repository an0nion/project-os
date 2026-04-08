/**
 * Google Calendar integration — single calendar, per-event colours via colorId.
 *
 * All events go into the primary calendar. Category is conveyed by colour only.
 *
 * Final colour scheme (user-approved):
 *
 *   Tomato    (11) — Warnings        red      cancel/subscription/expiry alerts
 *   Tangerine  (6) — Exam            orange   final exams
 *   Grape      (3) — Graded          purple   assignments, hw, graded deadlines  ← high priority
 *   Blueberry  (9) — Work            dark blue work tasks and deadlines
 *   Peacock    (7) — Appointments    teal     medical, dentist, outings w/ friends
 *   Banana     (5) — Birthdays       yellow   friend birthdays
 *   Sage       (2) — To-Do           green    small personal tasks (preference, not compulsory)
 *   Basil     (10) — School Tasks    dark grn self-directed uni tasks (preference, not compulsory)
 *   Lavender   (1) — Conference      lavender conferences, NeurIPS, ICML, ICLR
 *   Graphite   (8) — Unimportant     grey     events, optional, nice-to-attend — all merged
 */

import { supabase } from './supabase.js';

// ── colorId mapping ───────────────────────────────────────────────────────────
// Google Calendar API colorId values for events (1-11)
export const COLOR = {
  WARNINGS:      '11',  // Tomato     — red
  EXAM:          '6',   // Tangerine  — orange
  GRADED:        '3',   // Grape      — purple
  WORK:          '9',   // Blueberry  — dark blue
  APPOINTMENTS:  '7',   // Peacock    — teal
  BIRTHDAYS:     '5',   // Banana     — yellow
  TODO:          '2',   // Sage       — green
  SCHOOL_TASKS:  '10',  // Basil      — dark green
  CONFERENCE:    '1',   // Lavender   — lavender
  UNIMPORTANT:   '8',   // Graphite   — grey (events, optional, nice-to-attend)
};

// ── Route a message to the correct colorId ────────────────────────────────────
// Keyword checks run first (most specific), project fallback last.
export function pickColorId(project, text) {
  const t = (text ?? '').toLowerCase();

  if (/\bfinal exam|finals\b/.test(t))                                       return COLOR.EXAM;
  if (/\bassignment|\bhomework\b|\bhw\b|due date|submit|graded\b/.test(t))   return COLOR.GRADED;
  if (/\bbirthday|bday\b/.test(t))                                           return COLOR.BIRTHDAYS;
  if (/\bdoctor|dentist|physio|\bgp\b|outing|catch.?up/.test(t))            return COLOR.APPOINTMENTS;
  if (/\bcancel|subscription|renew|expires?|warning\b/.test(t))              return COLOR.WARNINGS;
  if (/\bconference|neurips|icml|iclr|\bnips\b|symposium/.test(t))          return COLOR.CONFERENCE;
  if (/\bevent|talk\b|info session|optional|seminar/.test(t))               return COLOR.UNIMPORTANT;

  switch (project) {
    case 'work':          return COLOR.WORK;
    case 'school':        return COLOR.SCHOOL_TASKS;
    case 'personal':      return COLOR.TODO;
    case 'research_apps': return COLOR.CONFERENCE;
    default:              return COLOR.TODO;
  }
}

// ── Token storage — single-user, keyed as 'bot' ───────────────────────────────
const TOKEN_KEY = 'bot';

async function getStoredTokens() {
  const { data } = await supabase
    .from('calendar_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', TOKEN_KEY)
    .single();
  return data ?? null;
}

export async function storeTokens({ access_token, refresh_token, expires_in, existing_refresh }) {
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();
  await supabase.from('calendar_tokens').upsert({
    user_id:       TOKEN_KEY,
    access_token,
    refresh_token: refresh_token ?? existing_refresh,
    expires_at:    expiresAt,
  });
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  await storeTokens({ ...data, existing_refresh: refreshToken });
  return data.access_token;
}

export async function getValidAccessToken() {
  const tokens = await getStoredTokens();
  if (!tokens) throw new Error('Calendar not connected — visit /api/calendar/auth');
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (expiresAt < Date.now() + 5 * 60 * 1000) {
    return refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

// ── Create a Google Calendar event ────────────────────────────────────────────
// date: 'YYYY-MM-DD' for all-day, ISO datetime string for timed events
// colorId: from COLOR map above — sets per-event colour, no calendar switching needed
export async function createCalendarEvent({ title, date, colorId, description }) {
  const accessToken = await getValidAccessToken();
  const isAllDay    = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '');
  const tz          = 'Australia/Melbourne';

  let start, end;
  if (isAllDay) {
    start = { date };
    const d = new Date(date); d.setDate(d.getDate() + 1);
    end = { date: d.toISOString().slice(0, 10) };
  } else {
    start = { dateTime: date, timeZone: tz };
    end   = { dateTime: new Date(new Date(date).getTime() + 3_600_000).toISOString(), timeZone: tz };
  }

  const body = { summary: title, description: description ?? '', start, end };
  if (colorId) body.colorId = colorId;

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  );
  const event = await res.json();
  if (!res.ok) throw new Error(event.error?.message ?? 'Google Calendar API error');
  return event;
}
