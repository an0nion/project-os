/**
 * Handler: morning-briefing
 * Builds a brief AI-generated morning briefing of today's items + upcoming
 * application deadlines, DM'd to SLACK_USER_ID.
 *
 * Invoked by `/api/cron/daily/route.js` and `/api/cron/run/[name]/route.js`.
 * Not an HTTP route — pure async function.
 */

import { callModelWithFallback } from '../../../../lib/multiModelClient.js';
import { startOfDayInTz, addDays, formatInTz } from '../../../../lib/timezone.js';

export async function run(db) {
  // DST-safe: midnight today in APP_TZ; "+1 day" preserves local clock across DST.
  const todayMidnight = startOfDayInTz();
  const todayStart    = todayMidnight.toISOString();
  const todayEnd      = addDays(todayMidnight, 1).toISOString();
  const dateStr       = formatInTz(todayMidnight, 'yyyy-MM-dd');

  const { data: dueToday } = await db
    .from('items')
    .select('title, project_key, status, due_date')
    .gte('due_date', todayStart)
    .lt('due_date', todayEnd)
    .neq('status', 'done');

  const cutoff = addDays(todayMidnight, 7).toISOString();
  const { data: upcoming } = await db
    .from('applications')
    .select('name, org, deadline, status')
    .neq('status', 'submitted')
    .gte('deadline', todayStart)
    .lte('deadline', cutoff)
    .order('deadline', { ascending: true });

  const hasDueToday = dueToday?.length > 0;
  const hasUpcoming = upcoming?.length > 0;

  if (!hasDueToday && !hasUpcoming) {
    return { summary: 'nothing due today or this week', skipped: true };
  }

  const contextLines = [];
  if (hasDueToday) {
    contextLines.push(`Items due TODAY (${dateStr}):`);
    for (const item of dueToday) {
      contextLines.push(`  - [${item.project_key}] ${item.title}`);
    }
  }
  if (hasUpcoming) {
    contextLines.push(`\nUpcoming application deadlines (next 7 days):`);
    for (const app of upcoming) {
      const daysLeft = Math.ceil((new Date(app.deadline) - todayMidnight) / 86_400_000);
      contextLines.push(`  - ${app.name} (${app.org}) — ${daysLeft}d left, status: ${app.status}`);
    }
  }

  const briefResult = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
    system: `You write brief, friendly morning briefings for a productive person.
Be direct and motivating. No filler phrases like "Good morning!" or "Let's get started!".
Start with the most time-sensitive thing. Max 4 sentences. Plain text, no markdown.`,
    messages: [{
      role:    'user',
      content: `Today is ${dateStr}. Here's what's on the agenda:\n\n${contextLines.join('\n')}\n\nWrite a brief morning briefing.`,
    }],
    maxTokens: 200,
  });

  const briefText = briefResult.text?.trim() ?? '';

  if (briefText && process.env.SLACK_USER_ID && process.env.SLACK_BOT_TOKEN) {
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
        body:    JSON.stringify({ channel: channel.id, text: briefText }),
      });
    }
  }

  return {
    summary:  `briefing sent (${dueToday?.length ?? 0} due, ${upcoming?.length ?? 0} upcoming)`,
    date:     dateStr,
    dueToday: dueToday?.length ?? 0,
    upcoming: upcoming?.length ?? 0,
    model:    briefResult.modelKey,
  };
}
