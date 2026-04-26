/**
 * POST /api/cron/run/[name]
 * Admin endpoint to manually run a single cron handler.
 *
 * Auth: bearer `CRON_SECRET`. (Unit 3 may add session-cookie auth in the future;
 * if so, add it here as a fallback. Bearer remains supported.)
 *
 * `[name]` must be one of:
 *   - deadline-nudges
 *   - cost-digest
 *   - morning-briefing
 *   - dedup-cleanup
 *   - calendar-backfill
 *
 * Useful for retrying a single failed step without re-running the whole daily job.
 */

import { NextResponse }       from 'next/server';
import { supabaseAdmin }      from '../../../../../lib/supabase.js';
import * as deadlineNudges    from '../../_handlers/deadline-nudges.js';
import * as costDigest        from '../../_handlers/cost-digest.js';
import * as morningBriefing   from '../../_handlers/morning-briefing.js';
import * as dedupCleanup      from '../../_handlers/dedup-cleanup.js';
import * as calendarBackfill  from '../../_handlers/calendar-backfill.js';

const HANDLER_MAP = {
  'deadline-nudges':   deadlineNudges,
  'cost-digest':       costDigest,
  'morning-briefing':  morningBriefing,
  'dedup-cleanup':     dedupCleanup,
  'calendar-backfill': calendarBackfill,
};

export async function POST(req, { params }) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const name = params?.name;
  const mod  = HANDLER_MAP[name];
  if (!mod) {
    return NextResponse.json(
      { error: 'unknown handler', valid: Object.keys(HANDLER_MAP) },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();
  const startedAt = new Date().toISOString();

  try {
    const result = await mod.run(db);
    console.log(`[cron-run] ${name} → ok:`, result?.summary ?? 'done');
    return NextResponse.json({ ok: true, name, startedAt, result });
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(`[cron-run] ${name} → failed:`, msg);
    return NextResponse.json(
      { ok: false, name, startedAt, error: msg },
      { status: 500 },
    );
  }
}
