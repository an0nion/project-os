/**
 * POST /api/calendar/event
 * Creates a Google Calendar event. Called by the Slack bot for reminders/deadlines.
 *
 * Body: see lib/schemas.js#CalendarEventPost (includes optional inbox_id)
 *
 * On success: { ok: true, data: { eventId, htmlLink } } and items.calendar_event_id
 *             is updated when inbox_id is provided.
 * On Calendar API failure: { ok: false, error: { code, message } } with HTTP 502 —
 *             the inbox row (if any) is NOT touched, so the backfill cron can retry.
 */

import { createCalendarEvent } from '../../../../lib/calendar.js';
import { supabase }            from '../../../../lib/supabase.js';
import { ok, fail }            from '../../../../lib/apiResponse.js';
import { CalendarEventPost }   from '../../../../lib/schemas.js';
import { ValidationError, AuthError, CalendarError } from '../../../../lib/errors.js';
import { log }                 from '../../../../lib/log.js';

export async function POST(req) {
  try {
    const secret = req.headers.get('x-api-secret');
    if (!secret || secret !== process.env.APP_SECRET) {
      throw new AuthError();
    }

    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = CalendarEventPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { title, date, colorId, description, durationMinutes, reminderMinutes, inbox_id } = parsed.data;

    let event;
    try {
      event = await createCalendarEvent({
        title,
        date,
        colorId: colorId !== undefined ? Number(colorId) : undefined,
        description,
        durationMinutes,
        reminderMinutes,
      });
    } catch (e) {
      log.warn('calendar:event', 'create_failed', { err: e.message });
      throw new CalendarError(e.message);
    }

    // Link-back to items row is non-fatal: backfill cron will resolve any miss.
    if (inbox_id && event?.id) {
      try {
        await supabase
          .from('items')
          .update({ calendar_event_id: event.id })
          .eq('id', inbox_id);
      } catch (err) {
        log.warn('calendar:event', 'inbox_link_failed', { err: err.message, inbox_id });
      }
    }

    return ok({ eventId: event.id, htmlLink: event.htmlLink });
  } catch (err) {
    log.error('calendar:event', 'failed', { err: err.message });
    return fail(err);
  }
}
