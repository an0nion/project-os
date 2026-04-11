/**
 * GET /api/cron/daily
 * Vercel cron job — runs daily at 00:00 UTC (14:00 AEST, configured in vercel.json).
 * Hobby plan allows exactly 1 cron slot, so deadline nudges + cost digest run together.
 *
 * Steps:
 *   1. Deadline nudges — Slack DM, Web Push, Telegram
 *   2. Cost digest    — yesterday's AI spend, DM'd to SLACK_USER_ID
 */

import { NextResponse }           from 'next/server';
import { supabaseAdmin }          from '../../../../lib/supabase.js';
import { sendSlackDeadlineNudge } from '../../../../slack/bot.js';
import { pushDeadlineAlert }      from '../../../../notifications/push.js';
import { sendDeadlineNudge }      from '../../../../notifications/telegram.js';

export async function GET(req) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();
  const results = {};

  // ── 1. Deadline nudges ────────────────────────────────────────────────────────
  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() + 7 * 86_400_000).toISOString();

    const { data: apps } = await db
      .from('applications')
      .select('*, questions(*)')
      .neq('status', 'submitted')
      .gte('deadline', now.toISOString())
      .lte('deadline', cutoff)
      .order('deadline', { ascending: true });

    if (apps?.length) {
      if (process.env.SLACK_USER_ID) {
        try {
          await sendSlackDeadlineNudge(process.env.SLACK_USER_ID, apps);
        } catch (err) {
          console.warn('[daily-cron] Slack deadline nudge failed:', err.message);
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
        console.warn('[daily-cron] Telegram deadline nudge failed:', err.message);
      }

      results.deadlines = { notified: apps.length };
    } else {
      results.deadlines = { notified: 0 };
    }
  } catch (err) {
    console.error('[daily-cron] deadline step failed:', err.message);
    results.deadlines = { error: err.message };
  }

  // ── 2. Cost digest ────────────────────────────────────────────────────────────
  try {
    // Yesterday window in AEST (UTC+10 / UTC+11 DST — use UTC+10 as conservative base)
    const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
    const nowUtc = Date.now();
    const todayAestMidnight = new Date(
      Math.floor((nowUtc + AEST_OFFSET_MS) / 86_400_000) * 86_400_000 - AEST_OFFSET_MS
    );
    const yesterdayStart = new Date(todayAestMidnight.getTime() - 86_400_000).toISOString();
    const yesterdayEnd   = todayAestMidnight.toISOString();

    const { data: rows } = await db
      .from('cost_log')
      .select('model_key, input_tokens, output_tokens, cached, purpose')
      .gte('logged_at', yesterdayStart)
      .lt('logged_at', yesterdayEnd);

    if (!rows?.length) {
      results.costDigest = { skipped: 'no rows for yesterday' };
    } else {
      // Aggregate by model
      const byModel = {};
      for (const r of rows) {
        const k = r.model_key ?? 'unknown';
        if (!byModel[k]) byModel[k] = { calls: 0, input: 0, output: 0, cached: 0 };
        byModel[k].calls++;
        byModel[k].input  += r.input_tokens  ?? 0;
        byModel[k].output += r.output_tokens ?? 0;
        byModel[k].cached += r.cached ? 1 : 0;
      }

      const date = yesterdayStart.slice(0, 10);
      const lines = Object.entries(byModel)
        .sort(([, a], [, b]) => (b.input + b.output) - (a.input + a.output))
        .map(([model, s]) => {
          const total = s.input + s.output;
          const cachedPct = s.calls > 0 ? Math.round((s.cached / s.calls) * 100) : 0;
          return `• *${model}* — ${s.calls} calls, ${total.toLocaleString()} tokens${cachedPct ? ` (${cachedPct}% cached)` : ''}`;
        });

      const totalCalls  = rows.length;
      const totalTokens = rows.reduce((n, r) => n + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);

      const text = `📊 *AI cost digest — ${date}*\n${lines.join('\n')}\n\n_${totalCalls} calls · ${totalTokens.toLocaleString()} total tokens_`;

      if (process.env.SLACK_USER_ID && process.env.SLACK_BOT_TOKEN) {
        const dmRes = await fetch('https://slack.com/api/conversations.open', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          body:    JSON.stringify({ users: process.env.SLACK_USER_ID }),
        });
        const { channel } = await dmRes.json();
        if (channel?.id) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            body:    JSON.stringify({ channel: channel.id, text }),
          });
        }
      }

      results.costDigest = { date, calls: totalCalls, tokens: totalTokens };
    }
  } catch (err) {
    console.error('[daily-cron] cost digest step failed:', err.message);
    results.costDigest = { error: err.message };
  }

  return NextResponse.json({ status: 'ok', checked_at: new Date().toISOString(), ...results });
}
