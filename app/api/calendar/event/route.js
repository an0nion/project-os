/**
 * POST /api/calendar/event
 * Creates a Google Calendar event. Called by the Slack bot for reminders/deadlines.
 *
 * Body: { title, date, colorId, description? }
 *   title       — event title
 *   date        — 'YYYY-MM-DD' for all-day, ISO datetime for timed
 *   colorId     — Google colorId 1-11 (see lib/calendar.js COLOR map)
 *   description — optional notes shown in the event
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

  const { title, date, colorId, description } = await req.json();
  if (!title || !date) {
    return NextResponse.json({ error: 'title and date required' }, { status: 400 });
  }

  try {
    const event = await createCalendarEvent({ title, date, colorId, description });
    return NextResponse.json({ ok: true, eventId: event.id, htmlLink: event.htmlLink });
  } catch (err) {
    console.error('[calendar/event]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
