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

import { supabaseAdmin }          from '../../../../lib/supabase.js';
import { sendSlackDeadlineNudge } from '../../../../slack/bot.js';
import { pushDeadlineAlert }      from '../../../../notifications/push.js';
import { sendDeadlineNudge }      from '../../../../notifications/telegram.js';
import { ok, fail }               from '../../../../lib/apiResponse.js';
import { AuthError }              from '../../../../lib/errors.js';
import { log }                    from '../../../../lib/log.js';

export async function GET(req) {
  try {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      throw new AuthError();
    }

    const db = supabaseAdmin();

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
      return ok({ status: 'ok', checked_at, notified: 0 });
    }

    if (process.env.SLACK_USER_ID) {
      try {
        await sendSlackDeadlineNudge(process.env.SLACK_USER_ID, apps);
      } catch (err) {
        log.warn('cron:deadlines', 'slack_nudge_failed', { err: err.message });
      }
    }

    const { data: subs } = await db.from('push_subscriptions').select('id, subscription');
    if (subs?.length) {
      const expiredIds = [];
      await Promise.allSettled(
        subs.flatMap(sub =>
          apps.map(app =>
            pushDeadlineAlert(sub.subscription, app).catch(err => {
              if (err.message === 'push_subscription_expired') expiredIds.push(sub.id);
            })
          )
        )
      );
      if (expiredIds.length) {
        await db.from('push_subscriptions').delete().in('id', [...new Set(expiredIds)]);
      }
    }

    try {
      await sendDeadlineNudge(apps);
    } catch (err) {
      log.warn('cron:deadlines', 'telegram_nudge_failed', { err: err.message });
    }

    return ok({ status: 'ok', checked_at, notified: apps.length });
  } catch (err) {
    log.error('cron:deadlines', 'failed', { err: err.message });
    return fail(err);
  }
}
