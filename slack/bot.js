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
// Use client_msg_id when available, fall back to ts (Slack's unique event timestamp).
const _seen = new Set();
function isDuplicate(message) {
  const key = message.client_msg_id ?? message.ts;
  if (!key) return false;
  if (_seen.has(key)) return true;
  _seen.add(key);
  if (_seen.size > 500) _seen.clear();
  return false;
}

// ── Pending clarification state ───────────────────────────────────────────────
// userId → { url, text, step: 1|2, context: 'work'|'personal' }
const clarificationPending = new Map();

/**
 * Returns true when routing context is ambiguous (work vs personal learning).
 * GitHub/arXiv/HuggingFace URLs are always ambiguous.
 * Generic "learn/check out" messages with no clear context are too.
 */
function isAmbiguous(text, urls) {
  const lower = text.toLowerCase();

  // Clear work signal → route directly, no clarification
  if (/\bfor work\b|\bat work\b|\bwork task\b|\bmy job\b|\bsprint\b|\bticket\b|\bdeployment\b/.test(lower)) return false;
  // Clear personal signal → route directly, no clarification
  if (/\bfor fun\b|\bpersonal\b|\bmy hobby\b|\bjust curious\b|\bcuriosity\b/.test(lower)) return false;

  // Tech repo/paper URLs → ambiguous
  if (urls.some(u => /github\.com|arxiv\.org|huggingface\.co|papers\.with\.code/.test(u))) return true;

  return false;
}

// ── URL extraction helper ─────────────────────────────────────────────────────

function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;

  if (message.text) urls.push(...(message.text.match(urlRegex) ?? []));

  if (message.blocks) {
    const walkElements = (elements) => {
      for (const el of elements ?? []) {
        if (el.type === 'link') urls.push(el.url);
        if (el.elements)        walkElements(el.elements);
      }
    };
    message.blocks.forEach(b => walkElements(b.elements));
  }

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

// ── API helpers ───────────────────────────────────────────────────────────────

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
  if (!text.startsWith('{')) {
    throw new Error(`Non-JSON response (status ${res.status}) — check APP_SECRET`);
  }
  return JSON.parse(text);
}

async function postInboxResult(say, data) {
  if (data.error) {
    await say(`⚠️ Couldn't process that: ${data.error}\n\nOpen the app: ${process.env.APP_URL}`);
    return;
  }
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

// ── Main DM listener ──────────────────────────────────────────────────────────

app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  if (message.subtype) return;           // ignore message_changed, message_deleted, etc.
  if (message.bot_id) return;
  if (isDuplicate(message)) return;

  const userId   = message.user;
  const urls     = extractUrls(message);
  const userText = message.text ?? '';

  // ── Handle pending clarification responses ─────────────────────────────────
  if (clarificationPending.has(userId)) {
    const state = clarificationPending.get(userId);

    // If the user sends a completely new message with a URL while we're mid-clarification,
    // abandon the old flow and treat this as a fresh message.
    const hasNewUrl = urls.length > 0;
    const isAboutOldItem = state.url && hasNewUrl && urls[0] === state.url;
    const isNewMessage   = hasNewUrl && !isAboutOldItem;

    if (isNewMessage) {
      clarificationPending.delete(userId);
      // Fall through to normal URL handling below
    } else {
      const lower = userText.toLowerCase();

      if (state.step === 1) {
        const isWork     = /\bwork\b/i.test(lower);
        const isPersonal = /\bpersonal\b|\blearning\b|\bfun\b|\bmine\b|\bcurious\b/i.test(lower);

        if (isWork) {
          clarificationPending.set(userId, { ...state, step: 2, context: 'work' });
          await say('Got it, work 💼\n\nAny urgency — *today*, *this week*, or *no rush*?');
          return;
        }
        if (isPersonal) {
          clarificationPending.set(userId, { ...state, step: 2, context: 'personal' });
          await say('Personal 📚\n\nWant to look at it *soon* or just *saving for later*?');
          return;
        }
        await say('Just checking — is this for *work* or *personal* learning?');
        return;
      }

      if (state.step === 2) {
        const project      = state.context === 'work' ? 'work' : 'learning_tech';
        const timeline     = userText.trim();
        const enrichedText = state.context === 'work'
          ? `[Work] ${state.text || state.url} — urgency: ${timeline}`
          : `[Personal learning] ${state.text || state.url} — timeline: ${timeline}`;

        clarificationPending.delete(userId);

        try {
          const data = await callInbox({
            url:    state.url || undefined,
            text:   enrichedText,
            source: 'slack',
            project,
          });
          await postInboxResult(say, data);
        } catch (err) {
          await say(`❌ Error: ${err.message}`);
        }
        return;
      }
    }
  }

  // ── Case 1: Message contains URLs ──────────────────────────────────────────
  if (urls.length > 0) {
    // Check if routing context is ambiguous
    if (isAmbiguous(userText, urls)) {
      clarificationPending.set(userId, { url: urls[0], text: userText, step: 1 });
      await say('Is this for *work* or *personal* learning?');
      return;
    }

    for (const url of urls) {
      await say(`⏳ Processing: ${url}`);
      try {
        const data = await callInbox({ url, text: userText, source: 'slack' });
        await postInboxResult(say, data);
      } catch (err) {
        await say(`❌ Error: ${err.message}`);
      }
    }
    return;
  }

  // ── Case 2: Text-only message ───────────────────────────────────────────────
  if (userText.trim()) {
    // Also check text-only ambiguity (e.g. "want to learn about transformers")
    if (isAmbiguous(userText, [])) {
      clarificationPending.set(userId, { url: null, text: userText, step: 1 });
      await say('Is this for *work* or *personal* learning?');
      return;
    }

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
    `Example: forward a post, paste a GitHub link, or type _"need to learn X for work"_`,
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
