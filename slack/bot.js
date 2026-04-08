/**
 * Slack DM Bot — Socket Mode
 *
 * Design principles:
 *   - Read context from the user's message upfront (personal/work, timeline)
 *   - Only ask for clarification when context is genuinely missing
 *   - Ask ONE question max, not two steps
 *   - Responses sound like a person, not a notification system
 *   - Silent on success unless there's something worth saying
 */

import 'dotenv/config';
import bolt from '@slack/bolt';
const { App } = bolt;

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── Deduplication ─────────────────────────────────────────────────────────────
const _seen = new Set();
function isDuplicate(message) {
  const key = message.client_msg_id ?? message.ts;
  if (!key) return false;
  if (_seen.has(key)) return true;
  _seen.add(key);
  if (_seen.size > 500) _seen.clear();
  return false;
}

// ── Pending clarification (userId → { url, text, step }) ─────────────────────
const pending = new Map();

// ── Context extraction ────────────────────────────────────────────────────────
// Read work/personal + timeline from user's message text upfront.
// Returns { context: 'work'|'personal'|null, timeline: string|null, urgency: 'urgent'|'soon'|'later'|null }
function parseContext(text) {
  if (!text) return { context: null, timeline: null, urgency: null };
  const t = text.toLowerCase();

  let context = null;
  if (/\bfor work\b|\bat work\b|\bwork (task|project|deadline|related)\b|\bmy job\b|\bsprint\b|\bticket\b/i.test(text))
    context = 'work';
  else if (/\bpersonal\b|\bfor (me|fun|myself)\b|\bmy own\b|\bcurious\b|\binterested in\b/i.test(text))
    context = 'personal';

  let timeline = null;
  const tlMatch = text.match(/within\s+(\d+[-–]\d+\s*\w+|\d+\s*\w+)|(\d+[-–]\d+\s*(months?|weeks?|days?))|in\s+(a\s+)?(week|month|few\s+weeks|couple\s+months)/i);
  if (tlMatch) timeline = tlMatch[0].replace(/^within\s+/i, '').trim();

  let urgency = null;
  if (/\btoday\b|\burgent\b|\basap\b|\bright now\b/i.test(t))      urgency = 'urgent';
  else if (/\bthis week\b|\bsoon\b|\bshortly\b/i.test(t))          urgency = 'soon';
  else if (/\bno rush\b|\blater\b|\beventually\b|\bsomeday\b/i.test(t)) urgency = 'later';

  return { context, timeline, urgency };
}

// ── Ambiguity check ───────────────────────────────────────────────────────────
// Only ambiguous if we genuinely can't tell work from personal AND it's a tech URL.
function isAmbiguous(text, urls, ctx) {
  if (ctx.context) return false;  // already know
  // Only ask for tech/learning content where the distinction matters
  const isTechUrl = urls.some(u => /github\.com|gitlab\.com|arxiv\.org|huggingface\.co|papers\.with\.code/.test(u));
  const isTechText = /\blearn\b|\bcheck\s+out\b|\bthis\s+(repo|paper|tool|project|lib)\b/i.test(text);
  return isTechUrl || isTechText;
}

// ── URL extraction (http/https only — ignore mailto:, tel:, etc.) ────────────
function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;
  if (message.text) urls.push(...(message.text.match(urlRegex) ?? []));
  if (message.blocks) {
    const walk = els => {
      for (const el of els ?? []) {
        if (el.type === 'link' && el.url?.startsWith('http')) urls.push(el.url);
        if (el.elements) walk(el.elements);
      }
    };
    message.blocks.forEach(b => walk(b.elements));
  }
  if (message.attachments) {
    for (const a of message.attachments) {
      if (a.original_url?.startsWith('http')) urls.push(a.original_url);
      if (a.from_url?.startsWith('http'))     urls.push(a.from_url);
      if (a.title_link?.startsWith('http'))   urls.push(a.title_link);
    }
  }
  return [...new Set(urls)].filter(u =>
    !u.includes('slack.com') && !u.includes('slack-edge.com')
  );
}

// ── Detect conversational messages directed at the bot ────────────────────────
// These are feedback/questions about the bot's behaviour, not things to save.
function isConversational(text) {
  return /^(see|why|how|what|you |u |did you|didn't you|can you|could you|should you|that's|thats|lol|haha|nice|ok|okay|wait|no,|yes,|yeah|nope)/i.test(text.trim());
}

// ── Detect application text with no real URL ──────────────────────────────────
// e.g. forwarded email/flyer about a program — has deadline/apply language but no link
function hasNoUsableUrl(urls, text) {
  if (urls.length > 0) return false;
  return /\bapply\b|\bapplication\b|\bdeadline\b|\bfellowship\b|\bresidency\b|\binternship\b/i.test(text);
}

// ── API call ──────────────────────────────────────────────────────────────────
async function callInbox(body) {
  const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  if (!text.startsWith('{')) throw new Error(`Non-JSON response (${res.status}) — check APP_SECRET`);
  return JSON.parse(text);
}

// ── Minimal success reply ─────────────────────────────────────────────────────
// One line, embedded link, no buttons, no blocks.
// Format: "saved to learning — <url|Title> · 1-2 months"
function buildSuccessMessage(data, ctx) {
  const title   = data.summary;
  const url     = data.itemId || data.appId
    ? `${process.env.APP_URL}/project/${data.project}`
    : null;

  const projectEmoji = {
    learning_tech:  '📚',
    work:           '💼',
    school:         '🎓',
    research_apps:  '🔬',
    baking:         '🍞',
    beadwork:       '📿',
    art:            '🎨',
    reading:        '📖',
    exercise:       '💪',
    circuitry:      '⚡',
  }[data.project] ?? '📁';

  const parts = [];

  // Title as embedded link if we have a project URL
  if (title && url) parts.push(`<${url}|${title}>`);
  else if (title)   parts.push(title);

  if (ctx.timeline) parts.push(ctx.timeline);

  const detail = parts.join(' · ');
  return `${projectEmoji} ${detail || 'saved'}`;
}

// ── Parse clarification reply for both context + timeline ─────────────────────
function parseClarificationReply(text) {
  const ctx = parseContext(text);
  // Also try bare keywords
  if (!ctx.context) {
    if (/\bwork\b/i.test(text)) ctx.context = 'work';
    else if (/\bpersonal\b|\bmine\b|\bme\b|\blearning\b/i.test(text)) ctx.context = 'personal';
  }
  return ctx;
}

// ── Post a clean one-liner (no link unfurls) ──────────────────────────────────
async function reply(channel, text) {
  await app.client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
}

// ── Main listener ─────────────────────────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  if (message.subtype) return;
  if (message.bot_id)  return;
  if (isDuplicate(message)) return;

  const userId   = message.user;
  const urls     = extractUrls(message);
  const userText = message.text ?? '';
  const ctx      = parseContext(userText);

  // Ignore conversational feedback/questions directed at the bot
  if (!pending.has(userId) && isConversational(userText) && urls.length === 0) return;

  // ── Pending clarification reply ───────────────────────────────────────────
  if (pending.has(userId)) {
    const state = pending.get(userId);

    // If they sent a new message (new URL or clearly new content), start fresh
    const isNewUrl = urls.length > 0 && (!state.url || urls[0] !== state.url);
    if (isNewUrl) {
      pending.delete(userId);
      // fall through to normal handling
    } else {
      // Search mode: user said they want to apply but gave no link
      if (state.searchMode) {
        if (/^y/i.test(userText.trim())) {
          pending.delete(userId);
          // Save as text — router will classify as research_apps, no URL to scrape
          try {
            const data = await callInbox({ text: state.text, source: 'slack', project: 'research_apps' });
            await reply(message.channel, buildSuccessMessage(data, {}));
          } catch {
            await say('couldn\'t save that');
          }
        } else {
          pending.delete(userId);
          await say('ok, ignored');
        }
        return;
      }

      const clarCtx = parseClarificationReply(userText);

      if (!clarCtx.context) {
        await say('work or personal?');
        return;
      }

      const project      = clarCtx.context === 'work' ? 'work' : 'learning_tech';
      const timeStr      = clarCtx.timeline ?? clarCtx.urgency ?? '';
      const enrichedText = [
        clarCtx.context === 'work' ? '[Work]' : '[Personal learning]',
        state.text || state.url || '',
        timeStr ? `— ${timeStr}` : '',
      ].filter(Boolean).join(' ');

      pending.delete(userId);

      try {
        const data = await callInbox({ url: state.url, text: enrichedText, source: 'slack', project });
        await reply(message.channel, buildSuccessMessage(data, clarCtx));
      } catch {
        await say('couldn\'t save that');
      }
      return;
    }
  }

  // ── URL message ───────────────────────────────────────────────────────────
  if (urls.length > 0) {
    const url = urls[0];

    // Context already in message → route directly, no question
    if (!isAmbiguous(userText, urls, ctx)) {
      const project = ctx.context === 'work' ? 'work' : null; // null = let router decide
      const enrichedText = buildEnrichedText(ctx, userText, url);

      try {
        const data = await callInbox({
          url,
          text:    enrichedText || userText || undefined,
          source:  'slack',
          ...(project ? { project } : {}),
        });
        await reply(message.channel, buildSuccessMessage(data, ctx));
      } catch {
        await say('couldn\'t save that');
      }
      return;
    }

    // Ambiguous → ask one short question
    pending.set(userId, { url, text: userText, step: 1 });
    await say('work or personal?');
    return;
  }

  // ── Text-only message ─────────────────────────────────────────────────────
  if (userText.trim()) {
    // Application/fellowship text with no link → ask to search
    if (hasNoUsableUrl(urls, userText)) {
      pending.set(userId, { url: null, text: userText, searchMode: true, step: 1 });
      await say('no link — want me to search for the application page? (y/n)');
      return;
    }

    if (isAmbiguous(userText, [], ctx)) {
      pending.set(userId, { url: null, text: userText, step: 1 });
      await say('work or personal?');
      return;
    }

    try {
      const data = await callInbox({ text: userText, source: 'slack' });
      await reply(message.channel, buildSuccessMessage(data, ctx));
    } catch {
      await say('couldn\'t save that');
    }
    return;
  }

  // ── Empty / unrecognised ──────────────────────────────────────────────────
  await say('send me a link or a note');
});

// ── Build enriched text for routing context ───────────────────────────────────
function buildEnrichedText(ctx, text, url) {
  const parts = [];
  if (ctx.context === 'work')     parts.push('[Work]');
  if (ctx.context === 'personal') parts.push('[Personal learning]');
  if (text && text !== url)       parts.push(text.replace(url, '').trim());
  if (ctx.timeline)               parts.push(`— ${ctx.timeline}`);
  return parts.filter(Boolean).join(' ');
}

// ── Deadline nudge ────────────────────────────────────────────────────────────
export async function sendSlackDeadlineNudge(slackUserId, apps) {
  const dm = await app.client.conversations.open({ users: slackUserId });

  const urgent = apps.filter(a => {
    const d = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    return d >= 0 && d <= 7 && a.status !== 'submitted';
  });
  if (urgent.length === 0) return;

  const lines = urgent.map(a => {
    const d          = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    const emoji      = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
    const unanswered = (a.questions ?? []).filter(q => !q.answer?.trim()).length;
    return `${emoji} *${a.org}* — ${d}d left${unanswered ? ` (${unanswered} questions remaining)` : ''}`;
  });

  await app.client.chat.postMessage({
    channel: dm.channel.id,
    text:    `Heads up — ${urgent.length} deadline${urgent.length > 1 ? 's' : ''} coming up`,
    blocks:  [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'actions', elements: [{ type: 'button', style: 'primary', action_id: 'open_nudge', text: { type: 'plain_text', text: 'Open app' }, url: process.env.APP_URL }] },
    ],
  });
}

await app.start();
console.log('✅ Project OS bot running');
