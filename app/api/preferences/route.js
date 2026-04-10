/**
 * GET  /api/preferences  — return current user preferences
 * POST /api/preferences  — update user preferences (merged into profile.data)
 *
 * Preferences are stored in the `profile` table's JSONB `data` column
 * under the key `calendar`. No schema migration required.
 *
 * Calendar preferences shape:
 *   {
 *     duration_minutes: number,    // default event duration (default 60)
 *     reminder_minutes: number[],  // popup reminders before event (default [30])
 *     default_notes:    string,    // notes appended to every calendar event (default "")
 *     setup_complete:   boolean,   // whether the user has configured preferences
 *   }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

const DEFAULT_CALENDAR_PREFS = {
  duration_minutes: 60,
  reminder_minutes: [30],
  default_notes:    '',
  setup_complete:   false,
};

async function getProfileData() {
  const { data } = await supabase
    .from('profile')
    .select('id, data')
    .limit(1)
    .single();
  return data ?? { id: null, data: {} };
}

export async function GET(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const profile = await getProfileData();
  const calendar = { ...DEFAULT_CALENDAR_PREFS, ...(profile.data?.calendar ?? {}) };
  return NextResponse.json({ calendar });
}

export async function POST(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const profile = await getProfileData();
  const existing = profile.data?.calendar ?? {};

  // Only accept known preference keys
  const updated = { ...existing };
  if (typeof body.duration_minutes === 'number' && body.duration_minutes > 0) {
    updated.duration_minutes = Math.min(body.duration_minutes, 480); // cap at 8h
  }
  if (Array.isArray(body.reminder_minutes)) {
    updated.reminder_minutes = body.reminder_minutes
      .filter(m => typeof m === 'number' && m >= 0 && m <= 10080)
      .slice(0, 5); // max 5 reminders
  }
  if (typeof body.default_notes === 'string') {
    updated.default_notes = body.default_notes.slice(0, 500);
  }
  if (typeof body.setup_complete === 'boolean') {
    updated.setup_complete = body.setup_complete;
  }

  const newData = { ...(profile.data ?? {}), calendar: updated };

  if (profile.id) {
    await supabase.from('profile').update({ data: newData, updated_at: new Date().toISOString() }).eq('id', profile.id);
  } else {
    await supabase.from('profile').insert({ data: newData });
  }

  return NextResponse.json({ calendar: { ...DEFAULT_CALENDAR_PREFS, ...updated } });
}
