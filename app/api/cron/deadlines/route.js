/**
 * GET /api/cron/deadlines
 * Vercel cron job — runs daily at 08:00 UTC (configured in vercel.json).
 * Free tier: 1 cron/day. If more frequency needed → GitHub Actions.
 *
 * Sends deadline nudges via:
 *   1. Slack DM  (always, if SLACK_USER_ID is set)
 *   2. Web Push  (always, to all stored push subscriptions)
 *   3. Telegram  (optional, if TELEGRAM_BOT_TOKEN is set)
 */

import { NextResponse }           from 'next/server';
import { supabaseAdmin }          from '../../../../lib/supabase.js';
import { sendSlackDeadlineNudge } from '../../../../slack/bot.js';
import { pushDeadlineAlert }      from '../../../../notifications/push.js';
import { sendDeadlineNudge }      from '../../../../notifications/telegram.js';

export async function GET(req) {
  // Verify this is a legitimate Vercel cron call
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();

  // Fetch all non-submitted apps with deadlines in the next 7 days
  const now    = new Date();
  const cutoff = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const { data: apps } = await db
    .from('applications')
    .select('*, questions(*)')
    .neq('status', 'submitted')
    .gte('deadline', now.toISOString())
    .lte('deadline', cutoff)
    .order('deadline', { ascending: true });

  const checked_at = new Date().toISOString();

  if (!apps?.length) {
    return NextResponse.json({ status: 'ok', checked_at, notified: 0 });
  }

  // ── Slack DM ────────────────────────────────────────────────────────────────
  if (process.env.SLACK_USER_ID) {
    try {
      await sendSlackDeadlineNudge(process.env.SLACK_USER_ID, apps);
    } catch (err) {
      console.warn('[Cron] Slack nudge failed:', err.message);
    }
  }

  // ── Web Push ─────────────────────────────────────────────────────────────────
  const { data: subs } = await db.from('push_subscriptions').select('id, subscription');
  if (subs?.length) {
    for (const app of apps) {
      for (const sub of subs) {
        try {
          await pushDeadlineAlert(sub.subscription, app);
        } catch (err) {
          if (err.message === 'push_subscription_expired') {
            await db.from('push_subscriptions').delete().eq('id', sub.id);
          }
        }
      }
    }
  }

  // ── Telegram (optional) ──────────────────────────────────────────────────────
  try {
    await sendDeadlineNudge(apps);
  } catch (err) {
    console.warn('[Cron] Telegram nudge failed:', err.message);
  }

  return NextResponse.json({ status: 'ok', checked_at, notified: apps.length });
}
