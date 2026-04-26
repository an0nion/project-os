/**
 * GET /api/cron/daily
 * Vercel cron job — runs daily at 14:00 UTC (configured in vercel.json).
 * Hobby plan allows exactly 1 cron slot, so all sub-jobs are fanned out from
 * here via direct function calls into `_handlers/`. Each handler runs
 * independently via `Promise.allSettled`, so one failure cannot abort the rest.
 *
 * Per-handler observability: every sub-result is logged + returned in the
 * response so failures show up in Vercel logs and the response body.
 *
 * Handlers:
 *   1. deadline-nudges    — Slack DM, Web Push, Telegram
 *   2. cost-digest        — yesterday's AI spend, DM'd to SLACK_USER_ID
 *   3. morning-briefing   — items due today + upcoming deadlines → AI summary
 *   4. dedup-cleanup      — stub (Unit 1b)
 *   5. calendar-backfill  — stub (Unit 1c)
 *
 * Manual single-handler retries: POST /api/cron/run/[name]
 */

import { NextResponse }        from 'next/server';
import { supabaseAdmin }       from '../../../../lib/supabase.js';
import { runCoordinator }      from '../_handlers/coordinator.js';
import * as deadlineNudges     from '../_handlers/deadline-nudges.js';
import * as costDigest         from '../_handlers/cost-digest.js';
import * as morningBriefing    from '../_handlers/morning-briefing.js';
import * as dedupCleanup       from '../_handlers/dedup-cleanup.js';
import * as calendarBackfill   from '../_handlers/calendar-backfill.js';

const HANDLERS = [
  ['deadlines',        deadlineNudges],
  ['costDigest',       costDigest],
  ['briefing',         morningBriefing],
  ['dedupCleanup',     dedupCleanup],
  ['calendarBackfill', calendarBackfill],
];

export async function GET(req) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();
  const { ok, results } = await runCoordinator(db, HANDLERS);

  return NextResponse.json({
    ok,
    checked_at: new Date().toISOString(),
    results,
  });
}
