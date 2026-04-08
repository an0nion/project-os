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

// ── Parse a natural-language timeline into YYYY-MM-DD (runs in bot process) ───
function parseTimelineToDate(timeline) {
  if (!timeline) return null;
  const now = new Date();
  const low = timeline.toLowerCase().trim();

  if (/\b(today|tonight|now|asap)\b/.test(low)) return now.toISOString().slice(0, 10);

  if (/\btomorrow\b/.test(low)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10);
  }

  // Day-of-week: "this Saturday", "next Monday", bare "Saturday"
  const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < DOW.length; i++) {
    if (new RegExp(`\\b${DOW[i]}\\b`).test(low)) {
      const d = new Date(now);
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0, 10);
    }
  }

  // Ordinal day: "13th", "13th of this month", "the 13th"
  const ordM = low.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordM) {
    const day = parseInt(ordM[1], 10);
    if (day >= 1 && day <= 31) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d <= now) d.setMonth(d.getMonth() + 1);
      return d.toISOString().slice(0, 10);
    }
  }

  // "in X weeks" / "in X days"
  const wk = low.match(/in (\d+) week/);
  if (wk) { const d = new Date(now); d.setDate(d.getDate() + parseInt(wk[1]) * 7); return d.toISOString().slice(0, 10); }
  const dy = low.match(/in (\d+) day/);
  if (dy) { const d = new Date(now); d.setDate(d.getDate() + parseInt(dy[1])); return d.toISOString().slice(0, 10); }

  // Native parse fallback: "June 13", "13 June"
  const stripped = low.replace(/^(by|on|at)\s+/, '');
  const parsed   = new Date(stripped);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= now.getFullYear()) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// ── Google Calendar colorId routing (single-calendar, per-event colours) ──────
// colorId 1-11 per Google Calendar API. No calendar switching needed.
function pickCalendarColor(project, text) {
  const t = (text ?? '').toLowerCase();
  if (/\bfinal exam|finals\b/.test(t))                                       return '6';  // Tangerine  — orange        — Exam
  if (/\bassignment|\bhomework\b|\bhw\b|due date|submit|graded\b/.test(t))   return '1';  // Lavender   — light purple  — Graded
  if (/\bbirthday|bday\b/.test(t))                                           return '5';  // Banana     — yellow        — Birthdays
  if (/\bdoctor|dentist|physio|\bgp\b|appointment|outing|catch.?up/.test(t)) return '3';  // Grape      — bright purple — Appointments
  if (/\bcancel|subscription|renew|expires?|warning\b/.test(t))              return '11'; // Tomato     — red           — Warnings
  if (/\bconference|neurips|icml|iclr|\bnips\b|symposium|seminar|talk\b|info session|event/.test(t)) return '4';  // Flamingo — salmon pink — Events + Conference
  if (/\boptional/.test(t))                                                  return '8';  // Graphite  — grey        — Optional only
  switch (project) {
    case 'work':          return '9';  // Blueberry  — dark blue
    case 'school':        return '10'; // Basil      — dark green
    case 'personal':      return '2';  // Sage       — bright green
    case 'research_apps': return '4';  // Flamingo   — salmon pink
    default:              return '2';
  }
}

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
  "intent": "save" | "correct" | "converse" | "search_request" | "reminder" | "recall",
  "context": "work" | "personal" | null,
  "timeline": string or null,
  "project_hint": string or null,
  "corrected_project": string or null,
  "needs_clarification": boolean,
  "priority_tier": 1 | 2 | 3 | 4 | null,
  "recall_topic": string or null
}

INTENT — pick exactly one:
- "recall": user asking what they previously saved, asked about, or captured — "what did I ask about X?", "I remember asking about Y", "what did you save on Z?", "what do I have on X?"
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

recall_topic: the specific topic/keyword the user is trying to recall — strip meta-query phrasing. E.g. "what did I ask about linear probes?" → "linear probes". Only set if intent=recall, else null.

needs_clarification: true ONLY if intent=save AND context is null AND content is tech-related (GitHub, paper, tool) where work vs personal distinction matters for routing

priority_tier: urgency and importance tier for task prioritisation:
  1 = hard deadline — specific date/time, exam, submission, interview; must happen by then
  2 = medium deadline — school/work/research task within weeks; time-bound but flexible
  3 = medium goal — personal learning, longer-term project, no firm deadline
  4 = hobby/interest — baking, art, reading, exercise, beadwork; whenever you get to it
  null = unclear from this message`;

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
    const validIntents = ['save', 'correct', 'converse', 'search_request', 'reminder', 'recall'];
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'save';

    return {
      intent,
      context:             parsed.context             ?? null,
      timeline:            parsed.timeline            ?? null,
      project_hint:        parsed.project_hint        ?? null,
      corrected_project:   parsed.corrected_project   ?? null,
      needs_clarification: parsed.needs_clarification ?? false,
      priority_tier:       parsed.priority_tier       ?? null,
      recall_topic:        parsed.recall_topic        ?? null,
    };
  } catch (err) {
    console.warn('[intent] classify failed:', err.message);
    const isShort = words.length <= 5;
    return {
      intent: isShort ? 'converse' : 'save',
      context: null, timeline: null, project_hint: null,
      corrected_project: null, needs_clarification: false,
      priority_tier: null, recall_topic: null,
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
        const reaskCount = (state.correctionStep ?? 0) + 1;
        if (reaskCount >= 2) {
          // Gave up — just confirm it stays where it is
          pending.delete(userId);
          await say(`ok, keeping it as-is`);
          return;
        }
        pending.set(userId, { ...state, correctionStep: reaskCount });
        await say("didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal");
        return;
      }
      pending.delete(userId);
      await callCorrect(state.logId, proj, userText);
      lastSaved.delete(userId);
      await say(`moved to ${proj} ✓`);
      return;
    }

    // Reminder date prompt — user is answering "when is this?"
    if (state.reminderMode) {
      const lc = userText.toLowerCase().trim();
      const isToDoReply = /^(to.?do|td|my list|add to list|no date|just add it|whenever)$/i.test(lc);

      if (isToDoReply) {
        // Save to personal Kanban, no calendar
        pending.delete(userId);
        try {
          const data = await callInbox({
            text:    state.reminderTitle,
            title:   state.reminderTitle,
            source:  'slack',
            project: 'personal',
          });
          if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: state.reminderTitle });
          await reply(message.channel, `🗓️ <${process.env.APP_URL}/project/personal|${state.reminderTitle.slice(0, 60)}> · added to your to-do list`);
        } catch { await say("couldn't save that"); }
        return;
      }

      // User gave a date — parse it and route to calendar
      const date = parseTimelineToDate(userText) ?? parseTimelineToDate(userText.replace(/^(on|at|by|this|next)\s+/i, ''));
      if (!date) {
        // Couldn't parse — re-ask once then save as to-do
        const reask = (state.reminderReask ?? 0) + 1;
        if (reask >= 2) {
          pending.delete(userId);
          try {
            await callInbox({ text: state.reminderTitle, title: state.reminderTitle, source: 'slack', project: 'personal' });
            await reply(message.channel, `🗓️ <${process.env.APP_URL}/project/personal|${state.reminderTitle.slice(0, 60)}> · added to your to-do list`);
          } catch { await say("couldn't save that"); }
          return;
        }
        pending.set(userId, { ...state, reminderReask: reask });
        await say(`didn't catch a date — try "this Saturday", "13th", "in 2 weeks", or say *to do* to add to your list`);
        return;
      }

      // Got a valid date — create calendar event
      pending.delete(userId);
      const colorId = pickCalendarColor('personal', state.originalText);
      let calCreated = false;
      if (process.env.CALENDAR_ENABLED === 'true') {
        try {
          const calRes = await fetch(`${process.env.APP_URL}/api/calendar/event`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
            body:    JSON.stringify({ title: state.reminderTitle, date, colorId, description: state.originalText }),
          });
          calCreated = calRes.ok;
        } catch (err) { console.error('[calendar] event creation failed:', err.message); }
      }
      await say(`📅 ${state.reminderTitle} · ${userText.trim()}${calCreated ? ' · added to calendar' : ''}`);
      return;
    }

    // Learning clarification mode — two-call architecture:
    // Call 1: classify reply as "action" or "chat" — tiny JSON, 60 tokens, never truncates
    // Call 2: if chat, conversational response with full history — plain text, 500 tokens
    // History: each exchange is stored so Call 2 can answer follow-up questions correctly.
    // Step cap: 8 chat turns before a soft check-in ("want me to save something?")
    if (state.learningMode) {
      const step    = state.step ?? 1;
      const history = state.history ?? [];
      let saveAsText = null;
      let chatReply  = null;

      // ── Build a clean, action-led Kanban title from the learning dialogue ────
      // Format: "Implement linear probes for AI alignment" — sentence-case, natural English.
      // Strips "I want to learn about / I want to" from the original topic.
      // Passed as forcedTitle to /api/inbox so the AI title extractor is bypassed.
      const buildLearningTitle = (action, topic) => {
        // Strip common filler openers from the topic
        const topicSlug = topic
          .replace(/^i (want to learn about|want to understand|am learning about|want to)\s*/i, '')
          .replace(/^(learn about|tell me about|explain|what is|what are)\s*/i, '')
          .trim();
        // Normalise action: strip "it", "the paper", etc. to get a clean verb
        const verb = action
          .replace(/\s+(it|the paper|more|about it|everything)$/i, '')
          .trim();
        // Capitalise first letter
        const title = `${verb.charAt(0).toUpperCase() + verb.slice(1)} ${topicSlug}`;
        return title.slice(0, 80);
      };

      // ── Fast-path: bare action words need no AI ────────────────────────────
      const bareAction = /^(read|implement|write|understand|learn|theory|both|all)(\s+(it|the paper|more|about it|everything))?$/i.test(userText.trim());
      if (bareAction) {
        pending.delete(userId);
        const task     = userText.trim().toLowerCase();
        const title    = buildLearningTitle(task, state.originalText);
        const enriched = `${task} — ${state.originalText.slice(0, 120)}`;
        try {
          const data = await callInbox({ text: enriched, title, source: 'slack', project: 'learning_tech' });
          await say(buildSuccessMessage(data));
        } catch { await say('saved ✓'); }
        return;
      }

      // ── Soft check-in response: user replied to "shall I save?" prompt ─────
      if (state.softCheckIn) {
        const lc = userText.toLowerCase().trim();
        if (/^(no|nah|nope|not yet|keep going|continue|later)/.test(lc)) {
          pending.set(userId, { ...state, softCheckIn: false });
          await say(`all good — keep going`);
          return;
        }
        // User said what to save (or anything non-negative) — save it
        pending.delete(userId);
        const saveText = userText.trim().slice(0, 60) || `Explore ${state.originalText.slice(0, 60)}`;
        const title    = buildLearningTitle(saveText, state.originalText);
        const enriched = `${saveText} — ${state.originalText.slice(0, 120)}`;
        try {
          const data = await callInbox({ text: enriched, title, source: 'slack', project: 'learning_tech' });
          if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
          await reply(message.channel, buildSuccessMessage(data, {}));
        } catch { await say("couldn't save that"); }
        return;
      }

      // ── Call 1: classify only — tiny JSON, never truncates ─────────────────
      let classifyType = null;
      try {
        const classifyResult = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
          system: `You are classifying a reply in a learning dialogue about: "${state.originalText.slice(0, 150)}"
The user was asked: "what do you want to do — read, implement, understand the theory, or write about it?"

Return ONLY valid JSON, nothing else: {"type": "action"} or {"type": "chat"}

type=action: reply is a short unambiguous task commitment. Examples:
  "implement it" → action  |  "read the paper" → action  |  "write a summary" → action
type=chat: everything else — user wants more info, is exploring, asking questions, or hasn't decided. When in doubt: chat.`,
          messages: [{ role: 'user', content: userText }],
          maxTokens: 60,
        });
        logCostViaApi(classifyResult.modelKey, classifyResult.usage, 'learning_classify');
        const raw    = classifyResult.text?.trim() ?? '';
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim());
        classifyType = parsed?.type ?? null;
      } catch (err) {
        console.error('[learningMode] classify call failed:', err.message);
      }

      // ── Decide based on classification ────────────────────────────────────
      if (classifyType === 'action') {
        saveAsText = userText.trim().slice(0, 60);

      } else if (classifyType === 'chat' && step < 8) {
        // ── Call 2: conversational response with full conversation history ────
        try {
          const explainResult = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
            system: `You are a knowledgeable research companion in an ongoing Slack conversation.
Topic the user is exploring: "${state.originalText.slice(0, 150)}"

Rules:
- Do NOT re-introduce or define the topic from scratch — respond directly to what the user just said.
- Match length to the user's question: short exploratory question → 2-3 sentences max. Detailed technical question → up to 5-6 sentences. Default to shorter.
- Be specific: cite real papers, researchers, findings by name when you know them. Mention them naturally, not as a list.
- Write like a colleague: no "Great question!", no textbook openers, no bullet points, no headers.
- End with a specific observation or question that opens the next line of inquiry. Not a menu of options.
- Plain text only.`,
            messages: [...history, { role: 'user', content: userText }],
            maxTokens: 500,
          });
          logCostViaApi(explainResult.modelKey, explainResult.usage, 'learning_explain');
          chatReply = explainResult.text?.trim() ?? null;
        } catch (err) {
          console.error('[learningMode] explain call failed:', err.message);
        }

      } else if (classifyType === 'chat' && step >= 8) {
        // Soft check-in: 8 turns is a solid conversation — offer to save without forcing
        const shortTopic = state.originalText.slice(0, 60);
        pending.set(userId, { ...state, softCheckIn: true });
        await say(`We've been deep in ${shortTopic} for a while — want me to save something specific to your Learning board so you can come back to it? If so, just say what you'd like to capture.`);
        return;

      } else if (classifyType === null && step >= 3) {
        // AI failed multiple times — save generic rather than loop forever
        saveAsText = `Explore and learn about ${state.originalText.slice(0, 60)}`;
      }

      if (chatReply) {
        const newHistory = [
          ...history,
          { role: 'user', content: userText },
          { role: 'assistant', content: chatReply },
        ];
        pending.set(userId, { ...state, step: step + 1, history: newHistory });
        await say(chatReply);
        return;
      }

      if (!saveAsText) {
        pending.set(userId, { ...state, step: step + 1 });
        await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
        return;
      }

      // Save the clean task
      pending.delete(userId);
      const title    = buildLearningTitle(saveAsText, state.originalText);
      const enriched = `${saveAsText} — ${state.originalText.slice(0, 120)}`;
      try {
        const data = await callInbox({ text: enriched, title, source: 'slack', project: 'learning_tech' });
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
        const reaskCount = (state.clarStep ?? 0) + 1;
        if (reaskCount >= 2) {
          // Can't determine context — save without forcing work/personal
          pending.delete(userId);
          try {
            const data = await callInbox({ url: state.url ?? undefined, text: state.text, source: 'slack' });
            if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
            await reply(message.channel, buildSuccessMessage(data, {}));
          } catch { await say('saved ✓'); }
          return;
        }
        pending.set(userId, { ...state, clarStep: reaskCount });
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
    pending.set(userId, { learningMode: true, originalText: userText, step: 1, history: [] });
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

  // Recall: user wants to know what they previously saved/asked about a topic
  if (cls.intent === 'recall') {
    const topic = cls.recall_topic ?? userText;
    try {
      const res = await fetch(
        `${process.env.APP_URL}/api/inbox/search?q=${encodeURIComponent(topic)}&limit=5`,
        { headers: { 'x-api-secret': process.env.APP_SECRET } },
      );
      const { results } = await res.json();
      if (!results?.length) {
        await say(`nothing saved about "${topic}" yet`);
        return;
      }
      const projectEmoji = {
        personal: '🗓️', learning_tech: '📚', work: '💼', school: '🎓',
        research_apps: '🔬', baking: '🍞', beadwork: '📿', art: '🎨',
        reading: '📖', exercise: '💪', circuitry: '⚡',
      };
      const lines = results.map(r => {
        const emoji   = projectEmoji[r.project] ?? '📁';
        const dateStr = r.saved_at ? ` · ${new Date(r.saved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : '';
        const link    = r.url ? `<${r.url}|${r.title}>` : r.title;
        return `${emoji} ${link}${dateStr}`;
      });
      await reply(message.channel, `here's what I have on "${topic}":\n${lines.join('\n')}`);
    } catch (err) {
      console.error('[recall] search failed:', err.message);
      await say("couldn't search that");
    }
    return;
  }

  // Reminder intent:
  //   Has date upfront → calendar immediately
  //   No date → ask "when is this?" — user replies with date or "to do"
  if (cls.intent === 'reminder') {
    // ── AI: extract clean actionable title ───────────────────────────────────
    let reminderTitle = null;
    try {
      const tr = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
        system: 'Extract the task or event name. Strip "remind me to", "set a reminder", dates, and time words. Capitalise first word only. Max 8 words. Examples: "remind me to buy cleansing oil on Saturday" → "Buy cleansing oil". "assignment notification for linear algebra Assignment 2 due 13th" → "Linear Algebra Assignment 2 due".',
        messages: [{ role: 'user', content: userText }],
        maxTokens: 25,
      });
      logCostViaApi(tr.modelKey, tr.usage, 'reminder_title');
      reminderTitle = tr.text?.trim().replace(/\.$/, '') || null;
    } catch { /* fallback below */ }

    if (!reminderTitle) {
      reminderTitle = userText
        .replace(/^(set (a )?reminder (for \S+ )?to|remind me to)\s*/i, '')
        .replace(/\s+(on|at|by|this|next)\s+\S.*$/i, '')
        .trim().slice(0, 60);
      reminderTitle = reminderTitle.charAt(0).toUpperCase() + reminderTitle.slice(1);
    }

    if (cls.timeline) {
      // ── Date provided upfront → calendar immediately ──────────────────────
      const date    = parseTimelineToDate(cls.timeline);
      const colorId = pickCalendarColor(cls.project_hint ?? 'personal', userText);
      let calCreated = false;

      if (process.env.CALENDAR_ENABLED === 'true' && date) {
        try {
          const calRes = await fetch(`${process.env.APP_URL}/api/calendar/event`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
            body:    JSON.stringify({ title: reminderTitle, date, colorId, description: userText }),
          });
          calCreated = calRes.ok;
        } catch (err) { console.error('[calendar] event creation failed:', err.message); }
      }
      await say(`📅 ${reminderTitle} · ${cls.timeline}${calCreated ? ' · added to calendar' : ''}`);

    } else {
      // ── No date → ask ─────────────────────────────────────────────────────
      pending.set(userId, { reminderMode: true, reminderTitle, originalText: userText });
      await say(`when is this? (or say *to do* to add to your list)`);
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
    pending.set(userId, { learningMode: true, originalText: userText, step: 1, history: [] });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
    return;
  }

  const url     = urls[0] ?? undefined;
  const project = cls.project_hint ?? (cls.context === 'work' ? 'work' : null);
  const enrichedText = buildEnrichedText(cls.context, cls.timeline, userText, url);

  try {
    const data = await callInbox({
      url,
      text:         enrichedText || userText || undefined,
      source:       'slack',
      timeline:     cls.timeline      ?? undefined,
      priority_tier: cls.priority_tier ?? undefined,
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
