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

import 'dotenv/config';
import bolt from '@slack/bolt';
const { App } = bolt;

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── Deduplication (Slack can fire the same event twice) ───────────────────────
const _seen = new Set();
function isDuplicate(clientMsgId) {
  if (!clientMsgId) return false;
  if (_seen.has(clientMsgId)) return true;
  _seen.add(clientMsgId);
  // Keep set small — clear old entries after 500 messages
  if (_seen.size > 500) _seen.clear();
  return false;
}

// ── URL extraction helper ─────────────────────────────────────────────────────

function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;

  // Plain text
  if (message.text) urls.push(...(message.text.match(urlRegex) ?? []));

  // Slack block kit
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

// ── API helper ────────────────────────────────────────────────────────────────

async function callInbox(body) {
  const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': process.env.APP_SECRET,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  // Guard against HTML responses (e.g. login redirect)
  if (!text.startsWith('{')) {
    throw new Error(`Non-JSON response (status ${res.status}) — check APP_SECRET`);
  }

  return JSON.parse(text);
}

// ── Main DM listener ──────────────────────────────────────────────────────────

app.message(async ({ message, say }) => {
  // Only respond to direct messages
  if (message.channel_type !== 'im') return;

  // Deduplicate — Slack sometimes delivers the same event twice
  if (isDuplicate(message.client_msg_id)) return;

  // Ignore bot messages (prevent echo loops)
  if (message.bot_id) return;

  const urls     = extractUrls(message);
  const userText = message.text ?? '';

  // ── Case 1: Message contains URLs ──────────────────────────────────────────
  if (urls.length > 0) {
    for (const url of urls) {
      await say(`⏳ Processing: ${url}`);

      try {
        const data = await callInbox({ url, text: userText, source: 'slack' });

        if (data.error) {
          await say(`⚠️ Couldn't process that link: ${data.error}\n\nOpen the app manually:\n${process.env.APP_URL}`);
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
                    (data.deadline ? `📅 Deadline: ${new Date(data.deadline).toLocaleDateString()}\n` : ''),
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

  // ── Case 2: Text-only message ───────────────────────────────────────────────
  if (userText.trim()) {
    try {
      const data = await callInbox({ text: userText, source: 'slack' });
      await say(
        `📋 Routed to *${data.projectLabel ?? data.project}*: ${data.summary ?? ''}\n` +
        `${process.env.APP_URL}?project=${data.project}`,
      );
    } catch (err) {
      await say(`❌ Error: ${err.message}`);
    }
    return;
  }

  // ── Case 3: Empty message ───────────────────────────────────────────────────
  await say(
    `Send me a link or a message and I'll route it to the right project.\n` +
    `Example: forward a post here, or type _"want to learn about X"_`,
  );
});

// ── Deadline nudge (called by cron) ──────────────────────────────────────────

export async function sendSlackDeadlineNudge(slackUserId, apps) {
  const dm = await app.client.conversations.open({ users: slackUserId });

  const urgent = apps.filter(a => {
    const d = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    return d >= 0 && d <= 7 && a.status !== 'submitted';
  });

  if (urgent.length === 0) return;

  let text = '📋 *Upcoming deadlines:*\n\n';
  for (const a of urgent) {
    const d          = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    const emoji      = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
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
