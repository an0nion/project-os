/**
 * Slack DM Bot — Socket Mode
 *
 * Design principles:
 *   - AI classifies every fresh message (intent, context, timeline, project hint)
 *   - Only ask for clarification when the AI genuinely can't tell
 *   - Ask ONE question max, not two steps
 *   - Responses sound like a person, not a notification system
 *   - Silent on success unless there's something worth saying
 */

import 'dotenv/config';
import bolt from '@slack/bolt';
import { callModelWithFallback } from '../lib/multiModelClient.js';

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

// ── Pending clarification (userId → { url, text, step, searchMode?, correctionMode? }) ──
const pending = new Map();

// ── Last saved item per user (for correction flow) ────────────────────────────
// userId → { logId, project, title }
// Expires after 5 minutes — corrections must be immediate
const lastSaved = new Map();
function setLastSaved(userId, data) {
  lastSaved.set(userId, { ...data, at: Date.now() });
  setTimeout(() => lastSaved.delete(userId), 5 * 60 * 1000);
}

// ── Project name → key map (for correction fallback parsing) ──────────────────
const PROJECT_ALIASES = {
  'school':        'school',        'uni': 'school',      'university': 'school',
  'work':          'work',          'job': 'work',
  'research':      'research_apps', 'applications': 'research_apps', 'apps': 'research_apps',
  'learning':      'learning_tech', 'tech': 'learning_tech', 'learn': 'learning_tech',
  'circuits':      'circuitry',     'electronics': 'circuitry',  'arduino': 'circuitry',
  'baking':        'baking',        'bread': 'baking',
  'beads':         'beadwork',      'beadwork': 'beadwork', 'jewelry': 'beadwork',
  'art':           'art',           'drawing': 'art', 'pastels': 'art',
  'reading':       'reading',       'books': 'reading',
  'exercise':      'exercise',      'gym': 'exercise', 'fitness': 'exercise',
};

function parseProjectFromText(text) {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
}

// ── AI Intent Classifier ──────────────────────────────────────────────────────
// Replaces: isConversational, isCorrection, isAmbiguous, hasNoUsableUrl, parseContext
// Returns: { intent, context, timeline, project_hint, corrected_project, needs_clarification }
const PROJECT_KEYS = [
  'school', 'work', 'research_apps', 'learning_tech',
  'baking', 'beadwork', 'art', 'reading', 'exercise', 'circuitry',
];

const INTENT_SYSTEM_PROMPT = `You are a message intent classifier for a personal project management Slack bot. The user sends short messages to save things or talk to you.

Return ONLY a valid JSON object with these exact fields (no markdown, no explanation):
{
  "intent": "save" | "correct" | "converse" | "search_request",
  "context": "work" | "personal" | null,
  "timeline": string or null,
  "project_hint": string or null,
  "corrected_project": string or null,
  "needs_clarification": boolean
}

Intent meanings:
- "save": user wants to capture something — URL, note, resource, program to apply to, task, reminder
- "correct": user says the bot routed the last item wrong ("wrong", "should be X", "→ school", "actually this is work", "no that's research")
- "converse": casual message not about saving — feedback on bot behavior, questions ("did you save that?", "why did you do that?"), reactions ("nice", "ok", "lol", "your formatting is bad", "did u add that?", "what happened"), greetings
- "search_request": user wants to apply to something (fellowship, program, internship) but gives no URL — implies they want help finding the link

context: "work" if clearly professional/job-related, "personal" if clearly personal, null if can't tell

timeline: extract any time reference and return concise string ("1-2 months", "by June", "this week", "ASAP") or null

project_hint: one of ${PROJECT_KEYS.join(', ')} — only if clearly identifiable:
- school: coursework, assignment, exam, essay, uni, lecture notes, academic submission
- work: job tasks, sprint, ticket, meeting, client, professional deadline
- research_apps: applying to fellowship/program/grant/PhD/internship/residency/competition
- learning_tech: GitHub repos, papers, tutorials, tools to explore (personal, not work)
- baking: recipes, bread, food, cooking
- beadwork: beading, jewelry, craft beadwork
- art: drawing, painting, pastels, sketching, visual art
- reading: books, articles to read for pleasure
- exercise: gym, fitness, workout, running, sport
- circuitry: Arduino, electronics, PCB, circuits, hardware hacking

corrected_project: same enum as project_hint — only set if intent is "correct" and user named a specific project; null otherwise

needs_clarification: true ONLY when all three are true:
1. intent is "save"
2. context is null (genuinely ambiguous between work and personal)
3. content is tech-related (GitHub, paper, tool, technical resource) where work vs personal routing matters`;

async function classifyIntent(text, urls) {
  const hasUrls = urls.length > 0;
  const urlList = urls.slice(0, 3).join(', ');
  const userContent = `Message: ${text || '(empty)'}${hasUrls ? `\nURLs: ${urlList}` : ''}`;

  try {
    // Gemini primary, DeepSeek fallback — handles Gemini 429 rate limits automatically
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system:    INTENT_SYSTEM_PROMPT,
      messages:  [{ role: 'user', content: userContent }],
      maxTokens: 150,
    });

    const raw    = result.text?.trim() ?? '';
    const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(json);

    return {
      intent:              parsed.intent              ?? 'save',
      context:             parsed.context             ?? null,
      timeline:            parsed.timeline            ?? null,
      project_hint:        parsed.project_hint        ?? null,
      corrected_project:   parsed.corrected_project   ?? null,
      needs_clarification: parsed.needs_clarification ?? false,
    };
  } catch (err) {
    console.warn('[intent] classify failed:', err.message);
    // Fallback: treat as a save — bot will still work, just without smart routing
    return { intent: 'save', context: null, timeline: null, project_hint: null, corrected_project: null, needs_clarification: false };
  }
}

// ── Correction API call ───────────────────────────────────────────────────────
async function callCorrect(logId, correctedProject, note) {
  const res = await fetch(`${process.env.APP_URL}/api/inbox/correct`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
    body:    JSON.stringify({ logId, correctedProject, note }),
  });
  return res.ok;
}

// ── Inbox API call ────────────────────────────────────────────────────────────
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

// ── URL extraction (http/https only — ignore mailto:, tel:, etc.) ─────────────
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

// ── Minimal success reply ─────────────────────────────────────────────────────
// One line, embedded link, no buttons, no blocks.
// Format: "📚 <url|Title> · 1-2 months"
function buildSuccessMessage(data, cls) {
  const projectEmoji = {
    learning_tech: '📚',
    work:          '💼',
    school:        '🎓',
    research_apps: '🔬',
    baking:        '🍞',
    beadwork:      '📿',
    art:           '🎨',
    reading:       '📖',
    exercise:      '💪',
    circuitry:     '⚡',
  }[data.project] ?? '📁';

  const appUrl = `${process.env.APP_URL}/project/${data.project}`;

  // Clean title: strip newlines, emoji codes, chars that break Slack link syntax
  const rawTitle = data.summary ?? '';
  const cleanTitle = rawTitle
    .replace(/\n|\r/g, ' ')
    .replace(/:[a-z_]+:/g, '')
    .replace(/[<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  const parts = [];
  if (cleanTitle) parts.push(`<${appUrl}|${cleanTitle}>`);
  if (cls?.timeline) parts.push(cls.timeline);

  return `${projectEmoji} ${parts.join(' · ') || 'saved'}`;
}

// ── Build enriched text for routing context ───────────────────────────────────
function buildEnrichedText(context, timeline, text, url) {
  const parts = [];
  if (context === 'work')     parts.push('[Work]');
  if (context === 'personal') parts.push('[Personal]');
  if (text && text !== url)   parts.push(text.replace(url ?? '', '').trim());
  if (timeline)               parts.push(`— ${timeline}`);
  return parts.filter(Boolean).join(' ');
}

// ── Parse a clarification reply (for pending work/personal question) ──────────
function parseClarificationContext(text) {
  const t = text.toLowerCase();
  if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(text)) return 'work';
  if (/\bpersonal\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  if (/^w\b/i.test(t.trim())) return 'work';     // bare "w"
  if (/^p\b/i.test(t.trim())) return 'personal';  // bare "p"
  return null;
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

  // ── Handle pending states first (no AI needed, user is answering a specific question) ──

  if (pending.has(userId)) {
    const state = pending.get(userId);

    // Correction mode: "which project did you mean?"
    if (state.correctionMode) {
      const proj = parseProjectFromText(userText);
      if (!proj) {
        await say("didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise");
        return;
      }
      pending.delete(userId);
      await callCorrect(state.logId, proj, userText);
      lastSaved.delete(userId);
      await say(`logged as ${proj}`);
      return;
    }

    // Search mode: "no link — want me to search? (y/n)"
    if (state.searchMode) {
      pending.delete(userId);
      if (/^y/i.test(userText.trim())) {
        try {
          const data = await callInbox({ text: state.text, source: 'slack', project: 'research_apps' });
          if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
          await reply(message.channel, buildSuccessMessage(data, {}));
        } catch {
          await say("couldn't save that");
        }
      } else {
        await say('ok, ignored');
      }
      return;
    }

    // Work/personal clarification mode
    // If they sent a genuinely new URL, abort pending and treat as a fresh message
    const isNewUrl = urls.length > 0 && urls[0] !== state.url;
    if (!isNewUrl) {
      const context = parseClarificationContext(userText);
      if (!context) {
        await say('work or personal?');
        return;
      }

      const project      = context === 'work' ? 'work' : 'learning_tech';
      const enrichedText = buildEnrichedText(context, null, state.text, state.url);
      pending.delete(userId);

      try {
        const data = await callInbox({ url: state.url ?? undefined, text: enrichedText, source: 'slack', project });
        if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
        await reply(message.channel, buildSuccessMessage(data, {}));
      } catch {
        await say("couldn't save that");
      }
      return;
    }

    // New URL arrived → drop pending, fall through to fresh handling
    pending.delete(userId);
  }

  // ── Fast path: pure URL with no extra context → always a save, skip AI ──────
  // The router classifies the URL content. No need to call Gemini just to
  // confirm that a bare URL is a "save" intent.
  const textWithoutUrls = urls.reduce((t, u) => t.replace(u, ''), userText).trim();
  const isPureUrl = urls.length > 0 && textWithoutUrls.length < 20;

  if (isPureUrl) {
    const url = urls[0];
    try {
      const data = await callInbox({ url, source: 'slack' });
      if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
      await reply(message.channel, buildSuccessMessage(data, {}));
    } catch {
      await say("couldn't save that");
    }
    return;
  }

  // ── Fresh message — classify intent with AI ───────────────────────────────
  const cls = await classifyIntent(userText, urls);

  // Conversational: ignore silently
  if (cls.intent === 'converse') return;

  // Correction: update the training log
  if (cls.intent === 'correct') {
    const prev = lastSaved.get(userId);
    if (!prev) {
      await say('nothing recent to correct');
      return;
    }

    const proj = cls.corrected_project ?? parseProjectFromText(userText);
    if (!proj) {
      pending.set(userId, { ...prev, correctionMode: true });
      await say('which project? (school / work / learning / research / art / baking / beads / circuits / reading / exercise)');
      return;
    }

    await callCorrect(prev.logId, proj, userText);
    lastSaved.delete(userId);
    await say(`got it — logged as ${proj}`);
    return;
  }

  // Search request: application text with no URL
  if (cls.intent === 'search_request') {
    pending.set(userId, { url: null, text: userText, searchMode: true, step: 1 });
    await say('no link — want me to search for the application page? (y/n)');
    return;
  }

  // Save — default intent
  if (cls.needs_clarification) {
    pending.set(userId, { url: urls[0] ?? null, text: userText, step: 1 });
    await say('work or personal?');
    return;
  }

  const url     = urls[0] ?? undefined;
  const project = cls.project_hint ?? (cls.context === 'work' ? 'work' : null);
  const enrichedText = buildEnrichedText(cls.context, cls.timeline, userText, url);

  try {
    const data = await callInbox({
      url,
      text:   enrichedText || userText || undefined,
      source: 'slack',
      ...(project ? { project } : {}),
    });
    if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
    await reply(message.channel, buildSuccessMessage(data, cls));
  } catch {
    await say("couldn't save that");
  }
});

// ── Deadline nudge (called externally by cron/scheduler) ─────────────────────
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
