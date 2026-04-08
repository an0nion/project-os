/**
 * Google Calendar integration — token management, calendar routing, event creation.
 *
 * Calendar name → purpose mapping (matches Google Calendar names exactly):
 *
 *   Work           (blue)   — work tasks and deadlines
 *   Warnings       (red)    — important alerts: cancel subscription, expiry, etc.
 *   Events         (pink)   — non-compulsory events, nice-to-attend, low priority
 *   Exam           (orange) — final exams
 *   Birthdays      (yellow) — friend birthdays
 *   To-Do          (green)  — small personal tasks
 *   School Tasks   (dark g) — self-directed uni tasks, agent-added
 *   Appointments   (purple) — medical, dentist, scheduled outings with friends
 *   Optional Events (grey)  — ignorable / informational
 *   Graded         (lavend) — assignments, homework, graded deadlines
 *   Conference     (cyan)   — conferences, NeurIPS, ICML, ICLR, seminars
 */

import { supabase } from './supabase.js';

// ── Calendar name constants (must match your Google Calendar names exactly) ───
export const CAL = {
  WORK:         'Work',
  WARNINGS:     'Warnings',
  EVENTS:       'Events',
  EXAM:         'Exam',
  BIRTHDAYS:    'Birthdays',
  TODO:         'To-Do',
  SCHOOL_TASKS: 'School Tasks',
  APPOINTMENTS: 'Appointments',
  OPTIONAL:     'Optional Events',
  GRADED:       'Graded',
  CONFERENCE:   'Conference',
};

// ── Route a save to the correct calendar based on project + text keywords ─────
// Keyword checks run first (most specific), project fallback runs last.
export function pickCalendar(project, text) {
  const t = (text ?? '').toLowerCase();

  if (/\bfinal exam|finals\b/.test(t))                                        return CAL.EXAM;
  if (/\bassignment|\bhomework\b|\bhw\b|due date|submit|graded\b/.test(t))    return CAL.GRADED;
  if (/\bbirthday|bday\b/.test(t))                                            return CAL.BIRTHDAYS;
  if (/\bdoctor|dentist|physio|gp\b|appointment|outing|catch.?up/.test(t))   return CAL.APPOINTMENTS;
  if (/\bcancel|subscription|renew|expires?|warning\b/.test(t))               return CAL.WARNINGS;
  if (/\bconference|neurips|icml|iclr|nips\b|symposium/.test(t))             return CAL.CONFERENCE;
  if (/\bseminar|optional event|lecture \(optional\)/.test(t))               return CAL.OPTIONAL;
  if (/\bevent|talk\b|info session/.test(t))                                  return CAL.EVENTS;

  switch (project) {
    case 'work':          return CAL.WORK;
    case 'school':        return CAL.SCHOOL_TASKS;
    case 'personal':      return CAL.TODO;
    case 'research_apps': return CAL.CONFERENCE;
    default:              return CAL.TODO;
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

async function storeTokens({ access_token, refresh_token, expires_in, existing_refresh }) {
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

  // Refresh 5 min before expiry
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (expiresAt < Date.now() + 5 * 60 * 1000) {
    return refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

export { storeTokens };

// ── Calendar list — cached in memory for process lifetime ─────────────────────
let _calIdCache = null;

async function resolveCalendarId(accessToken, calendarName) {
  if (!_calIdCache) {
    const res  = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json();
    _calIdCache = {};
    for (const cal of (body.items ?? [])) {
      _calIdCache[cal.summary] = cal.id;
    }
  }
  return _calIdCache[calendarName] ?? 'primary';
}

// ── Create a Google Calendar event ────────────────────────────────────────────
// date: 'YYYY-MM-DD' for all-day, or ISO datetime string for timed events
export async function createCalendarEvent({ title, date, calendarName, description }) {
  const accessToken = await getValidAccessToken();
  const calendarId  = await resolveCalendarId(accessToken, calendarName);

  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '');
  const tz       = 'Australia/Melbourne';

  let start, end;
  if (isAllDay) {
    start = { date };
    // All-day end is exclusive — next day
    const d = new Date(date); d.setDate(d.getDate() + 1);
    end = { date: d.toISOString().slice(0, 10) };
  } else {
    start = { dateTime: date, timeZone: tz };
    // Default 1-hour duration
    end   = { dateTime: new Date(new Date(date).getTime() + 3_600_000).toISOString(), timeZone: tz };
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ summary: title, description: description ?? '', start, end }),
    },
  );
  const event = await res.json();
  if (!res.ok) throw new Error(event.error?.message ?? 'Google Calendar API error');
  return event;
}
