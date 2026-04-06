/**
 * Web Push (VAPID) — completely free, no third-party service.
 *
 * Generate keys once: npm run vapid
 * Then set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env.local.
 *
 * Usage:
 *   import { sendPush, pushDeadlineAlert } from '../notifications/push.js';
 */

import webpush from 'web-push';

// Initialise VAPID once on module load
webpush.setVapidDetails(
  process.env.VAPID_EMAIL ?? 'mailto:admin@example.com',
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

/**
 * Send a raw push notification to one subscription endpoint.
 *
 * @param {object} subscription - The PushSubscription JSON stored in DB
 * @param {{ title, body, tag, url, actions }} payload
 */
export async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) {
      // Subscription expired — caller should delete it from DB
      const e = new Error('push_subscription_expired');
      e.subscriptionId = subscription.endpoint;
      throw e;
    }
    throw err;
  }
}

/**
 * Send a deadline alert push notification.
 *
 * @param {object} subscription
 * @param {{ id, org, deadline, questions }} app
 */
export async function pushDeadlineAlert(subscription, app) {
  const days      = Math.ceil((new Date(app.deadline) - new Date()) / 86_400_000);
  const unanswered = (app.questions ?? []).filter(q => !q.answer?.trim()).length;

  await sendPush(subscription, {
    title:   `${app.org} — ${days}d left`,
    body:    unanswered ? `${unanswered} question${unanswered > 1 ? 's' : ''} unanswered` : 'All questions answered ✓',
    tag:     `deadline-${app.id}`,
    url:     `/?project=research_apps&app=${app.id}`,
    actions: [
      { action: 'open',   title: '✍️ Answer now'   },
      { action: 'snooze', title: '⏰ Remind later'  },
    ],
  });
}

/**
 * Push to all stored subscriptions for a user.
 * Removes expired subscriptions automatically.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {object} payload
 */
export async function pushToUser(supabase, userId, payload) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, subscription')
    .eq('user_id', userId);

  if (!subs?.length) return;

  await Promise.all(
    subs.map(async row => {
      try {
        await sendPush(row.subscription, payload);
      } catch (err) {
        if (err.message === 'push_subscription_expired') {
          await supabase.from('push_subscriptions').delete().eq('id', row.id);
        }
      }
    }),
  );
}
