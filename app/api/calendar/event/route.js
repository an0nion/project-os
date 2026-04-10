/**
 * POST /api/calendar/event
 * Creates a Google Calendar event. Called by the Slack bot for reminders/deadlines.
 *
 * Body:
 *   title            — event title (required)
 *   date             — 'YYYY-MM-DD' for all-day, ISO datetime for timed (required)
 *   colorId          — Google colorId 1-11 (see lib/calendar.js COLOR map)
 *   description      — notes shown in the event body
 *   durationMinutes  — event length in minutes (default 60, ignored for all-day)
 *   reminderMinutes  — array of minutes-before for popup reminders (default [30])
 *
 * Returns: { ok, eventId, htmlLink }
 */

import { NextResponse }        from 'next/server';
import { createCalendarEvent } from '../../../../lib/calendar.js';

export async function POST(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { title, date, colorId, description, durationMinutes, reminderMinutes } = await req.json();
  if (!title || !date) {
    return NextResponse.json({ error: 'title and date required' }, { status: 400 });
  }

  try {
    const event = await createCalendarEvent({
      title,
      date,
      colorId,
      description,
      durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : undefined,
      reminderMinutes: Array.isArray(reminderMinutes) ? reminderMinutes : undefined,
    });
    return NextResponse.json({ ok: true, eventId: event.id, htmlLink: event.htmlLink });
  } catch (err) {
    console.error('[calendar/event]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
