/**
 * Slack DM-Only Bot — Socket Mode (no public URL needed)
 *
 * Required scopes (only 3):
 *   im:history  — read DMs sent to the bot
 *   im:write    — open DM conversations with users
 *   chat:write  — post messages
 *
 * Event subscription:
 *   message.im  — fires when someone DMs the bot
 *
 * Run: npm run slack
 */

import bolt from '@slack/bolt';
const { App } = bolt;

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── URL extraction helper ─────────────────────────────────────────────────────

function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;

  // Plain text
  if (message.text) urls.push(...(message.text.match(urlRegex) ?? []));

  // Slack block kit (forwarded/shared messages embed links in blocks)
  if (message.blocks) {
    const walkElements = (elements) => {
      for (const el of elements ?? []) {
        if (el.type === 'link') urls.push(el.url);
        if (el.elements)        walkElements(el.elements);
      }
    };
    message.blocks.forEach(b => walkElements(b.elements));
  }

  // Unfurled link previews in attachments
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.original_url) urls.push(att.original_url);
      if (att.from_url)     urls.push(att.from_url);
      if (att.title_link)   urls.push(att.title_link);
    }
  }

  return [...new Set(urls)].filter(u =>
    !u.includes('slack.com') && !u.includes('slack-edge.com'),
  );
}

// ── Main DM listener ──────────────────────────────────────────────────────────

app.message(async ({ message, say }) => {
  // Only respond to direct messages — ignore anything in channels
  if (message.channel_type !== 'im') return;

  const urls     = extractUrls(message);
  const userText = message.text ?? '';

  // ── Case 1: Message contains URLs ──────────────────────────────────────────
  if (urls.length > 0) {
    for (const url of urls) {
      await say(`⏳ Processing: ${url}`);

      try {
        const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ url, text: userText, source: 'slack' }),
        });
        const data = await res.json();

        if (data.error === 'scrape_failed') {
          // Scraping failed — send link to manual paste
          await say(
            `⚠️ Couldn't scrape that page automatically.\n\n` +
            `Open the app to paste the questions manually:\n` +
            `${process.env.APP_URL}?inbox=${encodeURIComponent(url)}`,
          );
        } else {
          await say({
            text: `✅ Added to *${data.projectLabel ?? data.project}*`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text:
                    `✅ *${data.summary ?? 'Added'}*\n` +
                    `→ Project: *${data.projectLabel ?? data.project}*\n` +
                    (data.questionsCount ? `❓ ${data.questionsCount} questions extracted\n` : '') +
                    (data.deadline       ? `📅 Deadline: ${new Date(data.deadline).toLocaleDateString()}\n` : ''),
                },
              },
              {
                type: 'actions',
                elements: [{
                  type:      'button',
                  text:      { type: 'plain_text', text: '✍️ Open in app' },
                  url:       `${process.env.APP_URL}?project=${data.project}`,
                  action_id: 'open_app',
                  style:     'primary',
                }],
              },
            ],
          });
        }
      } catch (err) {
        await say(`❌ Error: ${err.message}`);
      }
    }
    return;
  }

  // ── Case 2: Text-only message — route via AI ────────────────────────────────
  if (userText.trim()) {
    try {
      const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: userText, source: 'slack' }),
      });
      const data = await res.json();

      await say(
        `📋 Routed to *${data.projectLabel ?? data.project}*: ${data.summary ?? ''}\n` +
        `${process.env.APP_URL}?project=${data.project}`,
      );
    } catch {
      await say(`Added to inbox. Open the app to review:\n${process.env.APP_URL}`);
    }
    return;
  }

  // ── Case 3: Nothing useful (empty DM, sticker, etc.) ───────────────────────
  await say(
    `Send me a link or a message and I'll route it to the right project.\n` +
    `Example: forward a post here, or type _"want to learn about X"_`,
  );
});

// ── Deadline nudge (called by cron handler) ───────────────────────────────────

export async function sendSlackDeadlineNudge(slackUserId, apps) {
  const dm = await app.client.conversations.open({ users: slackUserId });

  const urgent = apps.filter(a => {
    const d = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    return d >= 0 && d <= 7 && a.status !== 'submitted';
  });

  if (urgent.length === 0) return;

  let text = '📋 *Upcoming deadlines:*\n\n';
  for (const a of urgent) {
    const d     = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    const emoji = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
    const unanswered = (a.questions ?? []).filter(q => !q.answer?.trim()).length;
    text += `${emoji} *${a.org}* — ${d}d left${unanswered ? ` (${unanswered} unanswered)` : ''}\n`;
  }

  await app.client.chat.postMessage({
    channel: dm.channel.id,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{
          type:      'button',
          text:      { type: 'plain_text', text: '✍️ Open app' },
          url:       process.env.APP_URL,
          action_id: 'open_from_nudge',
          style:     'primary',
        }],
      },
    ],
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

await app.start();
console.log('✅ Slack DM bot running (socket mode)');
