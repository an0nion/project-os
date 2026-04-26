/**
 * Handler: deadline-nudges
 * Sends deadline nudges via Slack DM, Web Push, and Telegram for applications
 * with deadlines in the next 7 days.
 *
 * Invoked by `/api/cron/daily/route.js` and `/api/cron/run/[name]/route.js`.
 * Not an HTTP route — pure async function.
 */

import { sendSlackDeadlineNudge } from '../../../../slack/bot.js';
import { pushDeadlineAlert }      from '../../../../notifications/push.js';
import { sendDeadlineNudge }      from '../../../../notifications/telegram.js';

export async function run(db) {
  const now    = new Date();
  const cutoff = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const { data: apps } = await db
    .from('applications')
    .select('*, questions(*)')
    .neq('status', 'submitted')
    .gte('deadline', now.toISOString())
    .lte('deadline', cutoff)
    .order('deadline', { ascending: true });

  if (!apps?.length) {
    return { summary: 'no upcoming deadlines', notified: 0 };
  }

  if (process.env.SLACK_USER_ID) {
    try {
      await sendSlackDeadlineNudge(process.env.SLACK_USER_ID, apps);
    } catch (err) {
      console.warn('[deadline-nudges] Slack nudge failed:', err.message);
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
    console.warn('[deadline-nudges] Telegram nudge failed:', err.message);
  }

  return { summary: `notified ${apps.length}`, notified: apps.length };
}
