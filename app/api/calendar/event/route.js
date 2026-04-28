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
 *   inbox_id         — optional UUID of the items row this event is linked to.
 *                      On success, items.calendar_event_id is updated with the
 *                      Google event id so the orphan-event backfill cron can
 *                      skip rows that already have a paired event.
 *                      On Calendar API failure, the items row is NOT touched.
 *
 * Returns: { ok, eventId, htmlLink } on success
 *          { ok: false, error } on Calendar API failure (HTTP 200 — caller decides retry)
 */

import { NextResponse }        from 'next/server';
import { createCalendarEvent } from '../../../../lib/calendar.js';
import { supabase }            from '../../../../lib/supabase.js';

export async function POST(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const {
    title, date, colorId, description, durationMinutes, reminderMinutes, inbox_id,
  } = await req.json();
  if (!title || !date) {
    return NextResponse.json({ error: 'title and date required' }, { status: 400 });
  }

  let event;
  try {
    event = await createCalendarEvent({
      title,
      date,
      colorId,
      description,
      durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : undefined,
      reminderMinutes: Array.isArray(reminderMinutes) ? reminderMinutes : undefined,
    });
  } catch (err) {
    console.error('[calendar/event]', err.message);
    // 200 + ok:false lets the bot decide retry without surfacing 5xx; the
    // inbox row is left untouched so the backfill cron can pick it up.
    return NextResponse.json({ ok: false, error: err.message });
  }

  // Link-back failure is non-fatal — backfill cron will resolve it later.
  if (inbox_id && event?.id) {
    try {
      await supabase
        .from('items')
        .update({ calendar_event_id: event.id })
        .eq('id', inbox_id);
    } catch (err) {
      console.error('[calendar/event] inbox link failed:', err.message);
    }
  }

  return NextResponse.json({ ok: true, eventId: event.id, htmlLink: event.htmlLink });
}
