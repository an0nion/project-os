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
const PROJECT_KEYS = [
  'personal', 'school', 'work', 'research_apps', 'learning_tech',
  'baking', 'beadwork', 'art', 'reading', 'exercise', 'circuitry',
];

const INTENT_SYSTEM_PROMPT = `You are a message intent classifier for a personal project management Slack bot.

Return ONLY valid JSON (no markdown, no explanation):
{
  "intent": "save" | "correct" | "converse" | "search_request" | "reminder",
  "context": "work" | "personal" | null,
  "timeline": string or null,
  "project_hint": string or null,
  "corrected_project": string or null,
  "needs_clarification": boolean
}

INTENT — pick exactly one:
- "converse": ANY of these → greetings (hi, hello, hey), one-word reactions (ok, nice, thanks, lol, :(, yes, no), feedback about the bot ("did you save that?", "why did you do that?", "your formatting is bad"), questions about what was just saved. When in doubt about a short ambiguous message, choose converse.
- "reminder": user wants to be reminded about something at a specific time/date ("remind me to...", "I have a [appointment/meeting/event] at [time]", "set a reminder for...")
- "search_request": user wants to apply to a fellowship/program/internship but has given no URL
- "correct": user says bot routed the last item wrong ("wrong", "should be X", "→ school", "actually this is work")
- "save": user explicitly wants to save a URL, note, paper, task, resource, application — clear capture intent

context: "work" if clearly professional, "personal" if clearly personal, null if ambiguous

timeline: concise time string ("5:30pm Thursday", "by June", "this week") or null

project_hint: one of ${PROJECT_KEYS.join(', ')} — only when clearly identifiable, else null:
- personal: appointments, errands, life admin, personal reminders, grooming
- school: coursework, assignments, exams, uni deadlines
- work: job tasks, sprint, tickets, professional deadlines
- research_apps: applying to fellowship/program/grant/PhD/internship/residency
- learning_tech: papers, GitHub repos, ML concepts, tutorials to explore (personal)
- baking: recipes, bread, food, cooking
- beadwork: beading, jewelry, craft
- art: drawing, painting, pastels, sketching
- reading: books, essays, philosophy to read
- exercise: gym, fitness, workouts, sport
- circuitry: Arduino, electronics, PCB, hardware

corrected_project: same enum — only set if intent=correct AND user named a project; null otherwise

needs_clarification: true ONLY if intent=save AND context is null AND content is tech-related (GitHub, paper, tool) where work vs personal distinction matters for routing`;

async function classifyIntent(text, urls) {
  const words = text.trim().split(/\s+/).filter(Boolean);

  // Short messages with no URLs are conversational — never save "hi", "ok", ":("
  // Avoids wasting an API call and prevents garbage saves on fallback errors
  if (urls.length === 0 && words.length <= 3) {
    return { intent: 'converse', context: null, timeline: null, project_hint: null, corrected_project: null, needs_clarification: false };
  }

  const hasUrls = urls.length > 0;
  const urlList = urls.slice(0, 3).join(', ');
  const userContent = `Message: ${text || '(empty)'}${hasUrls ? `\nURLs: ${urlList}` : ''}`;

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system:    INTENT_SYSTEM_PROMPT,
      messages:  [{ role: 'user', content: userContent }],
      maxTokens: 150,
    });

    logCostViaApi(result.modelKey, result.usage, 'intent_classification');

    const raw    = result.text?.trim() ?? '';
    const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(json);

    // Validate intent — unknown values default to save, not converse
    const validIntents = ['save', 'correct', 'converse', 'search_request', 'reminder'];
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'save';

    return {
      intent,
      context:             parsed.context             ?? null,
      timeline:            parsed.timeline            ?? null,
      project_hint:        parsed.project_hint        ?? null,
      corrected_project:   parsed.corrected_project   ?? null,
      needs_clarification: parsed.needs_clarification ?? false,
    };
  } catch (err) {
    console.warn('[intent] classify failed:', err.message);
    // Safe fallback: short messages go to converse, longer ones to save
    const isShort = words.length <= 5;
    return {
      intent: isShort ? 'converse' : 'save',
      context: null, timeline: null, project_hint: null,
      corrected_project: null, needs_clarification: false,
    };
  }
}

// ── Cost logging via API (avoids importing supabase on the VM) ────────────────
function logCostViaApi(modelKey, usage, reason) {
  if (!process.env.APP_URL || !usage) return;
  fetch(`${process.env.APP_URL}/api/costs/log`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
    body:    JSON.stringify({ modelKey, usage, reason }),
  }).catch(() => {}); // fire-and-forget, non-fatal
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
    personal:      '🗓️',
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
        await say("didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal");
        return;
      }
      pending.delete(userId);
      await callCorrect(state.logId, proj, userText);
      lastSaved.delete(userId);
      await say(`logged as ${proj}`);
      return;
    }

    // Learning clarification mode — AI decides what the reply actually means:
    // - Direct intent ("implement it", "read the paper") → extract clean task + save
    // - Wants more context ("tell me more", "explain it") → respond with a brief
    //   explanation of the topic, then ask again (max 1 exchange before forcing save)
    if (state.learningMode) {
      const step = state.step ?? 1;
      let saveAsText = null;  // AI-extracted clean task — set ONLY on unambiguous action
      let chatReply  = null;  // explanation to send — set when user still exploring

      try {
        // Use deepseek-chat as primary here — it follows strict classification rules
        // more reliably than Gemini Flash for ambiguous conversational inputs.
        const result = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
          system: `You are classifying a reply in a learning dialogue. Your job is to decide if the user has given a CLEAR TASK STATEMENT or is still exploring and needs more information.

Topic the user wants to learn: "${state.originalText.slice(0, 200)}"
You asked: "what do you want to do with this — read, implement something, understand the theory, or write about it?"

Return ONLY valid JSON (no markdown, no code fences):
{
  "type": "action" | "chat",
  "task": "clean verb-led task, max 80 chars (ONLY when type=action)",
  "reply": "2-3 sentences explaining the topic, end with: do you want to [implement / read / understand / write about] it? (ONLY when type=chat)"
}

DEFAULT TO type=chat. Only use type=action when the reply is a short, clean, unambiguous task and nothing else.

type=action — the reply is ONLY a task. Nothing but the task. Examples:
  "implement it from scratch" → action
  "read the paper" → action
  "understand the maths" → action
  "write a summary" → action

type=chat — everything else. When in doubt, choose chat. Examples:
  "I want to use it for AI safety but need to figure out a specific use case" → chat (uncertain, exploring)
  "well I want to do X but I want to figure out Y first so can you tell me more" → chat (wants info first)
  "tell me more about it" → chat
  "can you explain how it works?" → chat
  "I'll tell you how I want to use it after you explain" → chat (conditional)
  "I'm not sure yet, what do people usually do with it?" → chat (question)

RULE: if the reply mentions wanting to "figure out", asks a question, says they need more info, or is more than one sentence explaining their situation — it is type=chat. Only use type=action for a clean one-phrase task commitment.`,
          messages: [{ role: 'user', content: userText }],
          maxTokens: 220,
        });
        logCostViaApi(result.modelKey, result.usage, 'learning_reply_classify');

        const raw    = result.text?.trim() ?? '';
        const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        const parsed = JSON.parse(json);

        if (parsed.type === 'action' && parsed.task) {
          saveAsText = parsed.task;
        } else if (parsed.type === 'chat' && parsed.reply && step < 2) {
          chatReply = parsed.reply;
        } else if (parsed.type === 'chat' && step >= 2) {
          // Step limit reached — save a generic exploratory task rather than raw text
          saveAsText = `Explore and learn about ${state.originalText.slice(0, 60)}`;
        }
      } catch {
        // AI failed. At step 1: re-ask the question rather than saving garbage.
        // At step 2: save a generic task so we don't loop forever.
        if (step >= 2) {
          saveAsText = `Explore and learn about ${state.originalText.slice(0, 60)}`;
        }
      }

      // User still exploring → respond with context, keep state alive for one more turn
      if (chatReply) {
        pending.set(userId, { ...state, step: step + 1 });
        await say(chatReply);
        return;
      }

      // No clear intent yet at step 1 (AI failed or unclear) → re-ask rather than save garbage
      if (!saveAsText) {
        // Keep pending state; re-prompt with clarification question
        await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
        return;
      }

      // Save the clean task
      pending.delete(userId);
      const enriched = `${saveAsText} — ${state.originalText.slice(0, 120)}`;
      try {
        const data = await callInbox({ text: enriched, source: 'slack', project: 'learning_tech' });
        if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
        await reply(message.channel, buildSuccessMessage(data, {}));
      } catch {
        await say("couldn't save that");
      }
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

  // ── Pre-AI fast path: explicit learning intent with no URL ──────────────────
  // "I want to learn about X" is unambiguous — skip the AI call entirely and go
  // straight to the clarification dialogue. This prevents misclassification when
  // Gemini returns project_hint:null instead of learning_tech for these patterns.
  // Requires >5 words so bare "want to learn" (no topic) doesn't trigger.
  // "want to learn about X" patterns need > 5 words to ensure a topic is present
  const isExplicitLearning =
    urls.length === 0 && (() => {
      const words = userText.trim().split(/\s+/).filter(Boolean).length;
      // "I want to learn / been learning about / trying to learn" — needs > 5 words (topic required)
      if (words > 5 && /\b(want to learn|learning about|i'?m learning|been learning|trying to learn|i want to understand)\b/i.test(userText)) return true;
      // "tell me about X" / "explain X" — needs > 4 words (topic is part of the phrase itself)
      if (words > 4 && /\b(tell me about|explain to me|what is a|what are)\b/i.test(userText)) return true;
      return false;
    })();

  if (isExplicitLearning) {
    pending.set(userId, { learningMode: true, originalText: userText, step: 1 });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
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

  // Reminder/appointment: save to personal project with time context
  if (cls.intent === 'reminder') {
    const timeNote = cls.timeline ? ` — ${cls.timeline}` : '';
    try {
      const data = await callInbox({
        text:    userText + timeNote,
        source:  'slack',
        project: 'personal',
      });
      if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
      await reply(message.channel, `🗓️ <${process.env.APP_URL}/project/personal|${(data.summary ?? 'reminder').slice(0, 60)}>${timeNote ? ` · ${cls.timeline}` : ''}`);
    } catch {
      await say("couldn't save that");
    }
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

  // Vague learning intent with no URL → clarify before saving
  // "I want to learn about X" is not actionable. Ask what they actually want to do.
  const isVagueLearning = cls.project_hint === 'learning_tech' && urls.length === 0;
  if (isVagueLearning) {
    pending.set(userId, { learningMode: true, originalText: userText, step: 1 });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
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
