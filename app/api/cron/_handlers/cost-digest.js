/**
 * Handler: cost-digest
 * Aggregates yesterday's AI spend (from cost_log) and DMs a summary to SLACK_USER_ID.
 *
 * Invoked by `/api/cron/daily/route.js` and `/api/cron/run/[name]/route.js`.
 * Not an HTTP route — pure async function.
 */

const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

export async function run(db) {
  const nowUtc = Date.now();
  const todayAestMidnight = new Date(
    Math.floor((nowUtc + AEST_OFFSET_MS) / 86_400_000) * 86_400_000 - AEST_OFFSET_MS
  );
  const yesterdayStart = new Date(todayAestMidnight.getTime() - 86_400_000).toISOString();
  const yesterdayEnd   = todayAestMidnight.toISOString();

  const { data: rows } = await db
    .from('cost_log')
    .select('model, provider, tier, input_tokens, output_tokens, cost_usd, cached, reason')
    .gte('created_at', yesterdayStart)
    .lt('created_at', yesterdayEnd);

  if (!rows?.length) {
    return { summary: 'no rows for yesterday', skipped: true };
  }

  const byModel = {};
  for (const r of rows) {
    const k = r.model ?? 'unknown';
    if (!byModel[k]) byModel[k] = { calls: 0, input: 0, output: 0, cached: 0, cost: 0 };
    byModel[k].calls++;
    byModel[k].input  += r.input_tokens  ?? 0;
    byModel[k].output += r.output_tokens ?? 0;
    byModel[k].cached += r.cached ? 1 : 0;
    byModel[k].cost   += Number(r.cost_usd ?? 0);
  }

  const date = yesterdayStart.slice(0, 10);
  const lines = Object.entries(byModel)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, s]) => {
      const tokens    = s.input + s.output;
      const cachedPct = s.calls > 0 ? Math.round((s.cached / s.calls) * 100) : 0;
      const costStr   = s.cost > 0 ? ` · $${s.cost.toFixed(4)}` : '';
      return `• *${model}* — ${s.calls} calls, ${tokens.toLocaleString()} tokens${costStr}${cachedPct ? ` (${cachedPct}% cached)` : ''}`;
    });

  const totalCalls  = rows.length;
  const totalCost   = rows.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
  const totalTokens = rows.reduce((n, r) => n + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);

  const text = `📊 *AI cost digest — ${date}*\n${lines.join('\n')}\n\n_${totalCalls} calls · ${totalTokens.toLocaleString()} tokens · $${totalCost.toFixed(4)} total_`;

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

  return {
    summary: `${totalCalls} calls · $${totalCost.toFixed(4)}`,
    date,
    calls:  totalCalls,
    tokens: totalTokens,
    cost:   totalCost,
  };
}
