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
import { webSearch } from '../lib/search.js';

const { App } = bolt;

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── Regex fallback for timeline parsing (used if AI call fails) ───────────────
// Returns YYYY-MM-DD string or null. No time support — all-day events only.
function parseTimelineToDateFallback(timeline) {
  if (!timeline) return null;
  const now = new Date();
  const low = timeline.toLowerCase().trim();

  if (/\b(today|tonight|now|asap)\b/.test(low)) {
    // Use local Melbourne date, not UTC
    const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
    return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
  }

  if (/\btomorrow\b/.test(low)) {
    const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
    mel.setDate(mel.getDate() + 1);
    return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
  }

  // Day-of-week: "this Saturday", "next Monday", bare "Saturday"
  const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < DOW.length; i++) {
    if (new RegExp(`\\b${DOW[i]}\\b`).test(low)) {
      const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
      const diff = (i - mel.getDay() + 7) % 7 || 7;
      mel.setDate(mel.getDate() + diff);
      return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
    }
  }

  // Ordinal day: "13th", "13th of this month", "the 13th"
  const ordM = low.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordM) {
    const day = parseInt(ordM[1], 10);
    if (day >= 1 && day <= 31) {
      const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
      const d = new Date(mel.getFullYear(), mel.getMonth(), day);
      if (d <= mel) d.setMonth(d.getMonth() + 1);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  // "in X weeks" / "in X days"
  const wk = low.match(/in (\d+) week/);
  if (wk) {
    const d = new Date(now); d.setDate(d.getDate() + parseInt(wk[1]) * 7);
    return d.toISOString().slice(0, 10);
  }
  const dy = low.match(/in (\d+) day/);
  if (dy) {
    const d = new Date(now); d.setDate(d.getDate() + parseInt(dy[1]));
    return d.toISOString().slice(0, 10);
  }

  // Native parse fallback: "June 13", "13 June", "April 13, 2026"
  // Preserve original case (not `low`) so month names parse correctly via new Date()
  const stripped = timeline.trim().replace(/^(by|on|at)\s+/i, '');
  const parsed   = new Date(stripped);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= now.getFullYear()) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// ── AI-powered timeline parser — returns YYYY-MM-DD or full ISO datetime ───────
// Primary: DeepSeek for structured date/time extraction.
// Fallback: regex parser above (handles simple cases without API call).
// Returns: "YYYY-MM-DD" for all-day, "YYYY-MM-DDTHH:MM:00" for timed events, or null.
async function parseTimelineToDate(timeline) {
  if (!timeline) return null;

  const TZ = 'Australia/Melbourne';
  // Compute current Melbourne local time for AI context
  const mel = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const nowStr = `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')} ${String(mel.getHours()).padStart(2,'0')}:${String(mel.getMinutes()).padStart(2,'0')} (${TZ})`;

  try {
    const result = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
      system: `You are a precise date/time parser. Extract the date and optional time from the user's text.
Current date and time: ${nowStr}

Return ONLY valid JSON, nothing else:
- All-day (no specific time given): {"date": "YYYY-MM-DD"}
- Timed event (specific time given): {"datetime": "YYYY-MM-DDTHH:MM:00"}
- Cannot parse: {"error": "unparseable"}

Rules:
- All times are in ${TZ}
- "today" means the current date above
- "tomorrow" means the next calendar day
- Ordinal days ("13th") refer to this month if not yet passed, otherwise next month
- Use 24-hour format for datetime output
- Dot notation times: "5.20pm" = "17:20"

Examples given current date ${nowStr.split(' ')[0]}:
"tomorrow" → {"date": "${(() => { const d = new Date(mel); d.setDate(d.getDate()+1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()}"}
"today at 5.20pm" → {"datetime": "${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}T17:20:00"}
"this Saturday at 2pm" → (compute next Saturday date with T14:00:00)
"13th" → (compute correct month's 13th)
"in 2 weeks" → {"date": "(date + 14 days)"}
"next month" → {"error": "unparseable"}`,
      messages: [{ role: 'user', content: timeline }],
      maxTokens: 60,
    });
    logCostViaApi(result.modelKey, result.usage, 'timeline_parse');

    const raw    = result.text?.trim() ?? '';
    const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(json);

    if (parsed.error)    return null;
    if (parsed.datetime) return parsed.datetime;  // ISO datetime — timed calendar event
    if (parsed.date)     return parsed.date;       // date-only — all-day event
    return null;

  } catch (err) {
    console.warn('[parseTimelineToDate] AI parse failed:', err.message, '— falling back to regex');
    return parseTimelineToDateFallback(timeline);
  }
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
  'personal':      'personal',
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

const VALID_INTENTS = ['save', 'correct', 'converse', 'search_request', 'reminder', 'recall', 'web_search'];

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a personal project management Slack bot.

The user may send ONE task or MULTIPLE tasks in a single message (e.g. "remind me to X, also add Y").
Always return an array of tasks — even if there is only one.

Return ONLY valid JSON (no markdown):
{
  "tasks": [
    {
      "intent": "save" | "reminder" | "recall" | "correct" | "search_request" | "web_search" | "converse",
      "title": string,
      "timeline": string or null,
      "context": "work" | "personal" | null,
      "project_hint": string or null,
      "priority_tier": 1 | 2 | 3 | 4 | null,
      "needs_clarification": boolean,
      "corrected_project": string or null,
      "recall_topic": string or null,
      "search_query": string or null
    }
  ]
}

INTENT:
- "reminder": user wants to be reminded / notified / has an appointment or deadline
- "recall": asking what was previously saved — "what did I save about X?", "what do I have on Y?"
- "web_search": user wants to look something up in real time — event dates, locations, deadlines of external things, "when is X", "what time does Y start", "where is Z being held", "find the date of". Use this for anything requiring live information NOT stored by the bot.
- "converse": greetings, one-word reactions, meta-questions about the bot, "set preferences", "preferences"
- "correct": user says last save was routed wrong
- "search_request": wants to apply to a program/fellowship but gave no URL
- "save": everything else — save a URL, paper, task, note, resource

title: clean, actionable task name. Strip filler: "remind me to", "set a reminder", "set a notification", "also", dates, time phrases. Capitalise first word. Max 8 words.
  Examples:
    "set a reminder for this Saturday to buy cleansing oil" → "Buy cleansing oil"
    "set an assignment notification for the 13th for linear algebra Assignment 2" → "Linear Algebra Assignment 2"
    "I want to save this arxiv paper on diffusion" → "Diffusion paper (arxiv)"

timeline: the specific date/time string for this task only, as the user said it. null if none.
  Examples: "this Saturday", "13th of this month", "by June 30", "5:30pm Thursday"

search_query: only if intent=web_search — an optimised search query (proper nouns, event name, location). Strip meta-phrasing like "what's the date of" or "when is". Keep the subject.
  Examples: "when is the Square Peg Claude Code event Melbourne" → "Square Peg Claude Code event Melbourne luma"

project_hint: one of ${PROJECT_KEYS.join(', ')} or null:
  personal=appointments/errands/life admin, school=coursework/exams/uni,
  work=job tasks/sprint/tickets, research_apps=fellowships/grants/PhD,
  learning_tech=papers/ML/repos, baking=recipes/bread, beadwork=jewelry/craft,
  art=drawing/pastels, reading=books/essays, exercise=gym/sport, circuitry=Arduino/PCB

priority_tier:
  1=hard deadline (specific date, exam, submission)
  2=medium deadline (school/work task, weeks away)
  3=medium goal (personal learning, no firm date)
  4=hobby/interest (baking/art/reading/exercise)
  null=unclear

needs_clarification: true only if intent=save AND context null AND tech content (work vs personal unclear)
corrected_project: only if intent=correct AND user named a project
recall_topic: only if intent=recall — the topic to search for, stripped of meta-phrasing`;

function normaliseTask(t) {
  const tier = t.priority_tier;
  return {
    intent:              VALID_INTENTS.includes(t.intent) ? t.intent : 'save',
    title:               typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null,
    timeline:            typeof t.timeline === 'string' && t.timeline.trim() ? t.timeline.trim() : null,
    context:             t.context             ?? null,
    project_hint:        PROJECT_KEYS.includes(t.project_hint) ? t.project_hint : null,
    priority_tier:       (Number.isInteger(tier) && tier >= 1 && tier <= 4) ? tier : null,
    needs_clarification: t.needs_clarification === true,
    corrected_project:   t.corrected_project   ?? null,
    recall_topic:        typeof t.recall_topic === 'string' && t.recall_topic.trim() ? t.recall_topic.trim() : null,
    search_query:        typeof t.search_query === 'string' && t.search_query.trim() ? t.search_query.trim() : null,
  };
}

// Returns an array of task objects — always at least one.
async function classifyIntent(text, urls) {
  const words = text.trim().split(/\s+/).filter(Boolean);

  // Very short messages with no URLs (≤2 words) are always conversational.
  // 3-word messages go to the AI — "add this" (2 words) was silently discarded
  // but "add this now" (3 words) needs classification.
  if (urls.length === 0 && words.length <= 2) {
    return [normaliseTask({ intent: 'converse' })];
  }

  const hasUrls    = urls.length > 0;
  const userContent = `Message: ${text || '(empty)'}${hasUrls ? `\nURLs: ${urls.slice(0, 3).join(', ')}` : ''}`;

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system:    INTENT_SYSTEM_PROMPT,
      messages:  [{ role: 'user', content: userContent }],
      maxTokens: 300,
    });

    logCostViaApi(result.modelKey, result.usage, 'intent_classification');

    const raw    = result.text?.trim() ?? '';
    const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(json);

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [parsed];
    return tasks.map(normaliseTask);

  } catch (err) {
    console.warn('[intent] classify failed:', err.message);
    return [normaliseTask({ intent: words.length <= 5 ? 'converse' : 'save' })];
  }
}

// ── User preferences (calendar duration, reminders, notes) ───────────────────
// Loaded on demand, cached in memory. Refreshed when the user updates preferences.
const DEFAULT_PREFS = { duration_minutes: 60, reminder_minutes: [30], default_notes: '', setup_complete: false };
let cachedPrefs = null;

async function getCalendarPrefs() {
  if (cachedPrefs) return cachedPrefs;
  try {
    const res = await fetch(`${process.env.APP_URL}/api/preferences`, {
      headers: { 'x-api-secret': process.env.APP_SECRET },
    });
    if (res.ok) {
      const { calendar } = await res.json();
      cachedPrefs = { ...DEFAULT_PREFS, ...calendar };
      return cachedPrefs;
    }
  } catch {}
  return DEFAULT_PREFS;
}

async function saveCalendarPrefs(updates) {
  try {
    const res = await fetch(`${process.env.APP_URL}/api/preferences`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
      body:    JSON.stringify(updates),
    });
    if (res.ok) {
      const { calendar } = await res.json();
      cachedPrefs = { ...DEFAULT_PREFS, ...calendar };
    }
  } catch (err) {
    console.error('[prefs] save failed:', err.message);
  }
}

// Parse a human reminder string into minutes: "30 min", "1 hour", "none", "15"
function parseReminderMinutes(text) {
  const t = text.toLowerCase().trim();
  if (/\b(none|no|off|never|skip)\b/.test(t)) return [];
  const hourMatch = t.match(/(\d+)\s*h(our)?/);
  const minMatch  = t.match(/(\d+)\s*m(in)?/);
  const bareNum   = t.match(/^(\d+)$/);
  const reminders = [];
  if (hourMatch) reminders.push(parseInt(hourMatch[1]) * 60);
  if (minMatch)  reminders.push(parseInt(minMatch[1]));
  if (bareNum && !hourMatch && !minMatch) reminders.push(parseInt(bareNum[1]));
  return reminders.length ? reminders : null; // null = couldn't parse
}

// Parse a human duration string into minutes: "30 min", "1 hour", "2h", "90"
function parseDurationMinutes(text) {
  const t = text.toLowerCase().trim();
  const hourMatch = t.match(/(\d+)\s*h(our)?/);
  const minMatch  = t.match(/(\d+(?:\.\d+)?)\s*m(in)?/);
  const bareNum   = t.match(/^(\d+)$/);
  if (hourMatch) return parseInt(hourMatch[1]) * 60 + (minMatch ? parseInt(minMatch[1]) : 0);
  if (minMatch)  return parseInt(minMatch[1]);
  if (bareNum)   return parseInt(bareNum[1]);
  return null;
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
  if (/\bpersonal\b|\bperson\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  if (/^w\b/i.test(t.trim())) return 'work';     // bare "w"
  if (/^p\b/i.test(t.trim())) return 'personal';  // bare "p"
  return null;
}

// ── Post a clean one-liner (no link unfurls) ──────────────────────────────────
async function reply(channel, text) {
  await app.client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
}

// ── Create a calendar event with user preferences applied ────────────────────
async function createCalendarEventWithPrefs({ title, date, colorId, description }) {
  const prefs = await getCalendarPrefs();
  const notes = [description, prefs.default_notes].filter(Boolean).join('\n\n') || '';
  const calRes = await fetch(`${process.env.APP_URL}/api/calendar/event`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
    body:    JSON.stringify({
      title,
      date,
      colorId,
      description:     notes,
      durationMinutes: prefs.duration_minutes,
      reminderMinutes: prefs.reminder_minutes,
    }),
  });
  if (!calRes.ok) {
    const errBody = await calRes.text().catch(() => '(unreadable)');
    console.error(`[calendar] event creation failed: HTTP ${calRes.status}`, errBody.slice(0, 300));
  }
  return calRes.ok;
}

// ── Process a single reminder task ───────────────────────────────────────────
// cls.title is the AI-extracted clean title from classifyIntent — no extra call needed.
// If timeline is present → create calendar event immediately.
// If no timeline → ask "when is X?" and wait for reminderMode reply.
async function processReminderTask(cls, channel, userId, say) {
  const reminderTitle = (cls.title ?? '').trim().slice(0, 60) || 'Reminder';

  if (cls.timeline) {
    const date    = await parseTimelineToDate(cls.timeline);
    const colorId = pickCalendarColor(cls.project_hint ?? 'personal', reminderTitle);
    let calCreated = false;

    if (process.env.CALENDAR_ENABLED === 'true' && date) {
      try {
        calCreated = await createCalendarEventWithPrefs({ title: reminderTitle, date, colorId, description: cls.title ?? reminderTitle });
      } catch (err) { console.error('[calendar] event creation failed (network):', err.message); }
    }
    await reply(channel, `📅 ${reminderTitle} · ${cls.timeline}${calCreated ? ' · added to calendar' : ''}`);

  } else {
    pending.set(userId, { reminderMode: true, reminderTitle, originalText: cls.title ?? reminderTitle });
    await say(`when is "${reminderTitle}"? (or say *to do* to add to your list)`);
  }
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

    // Preferences setup flow — multi-step, tracks which field we're collecting
    if (state.prefsMode) {
      const step = state.prefsStep ?? 0;
      const t    = userText.trim();

      if (step === 0) {
        // Duration
        const mins = parseDurationMinutes(t);
        if (!mins || mins < 5 || mins > 480) {
          pending.set(userId, { ...state, prefsStep: 0 });
          await say(`didn't catch that — enter a duration like "30 min", "1 hour", or "90 min" (5–480 min)`);
          return;
        }
        pending.set(userId, { ...state, prefsStep: 1, duration: mins });
        await say(`got it — ${mins} min events. How many minutes before should I remind you? (e.g. "30 min", "1 hour", or "none")`);
        return;
      }

      if (step === 1) {
        // Reminders
        const reminders = parseReminderMinutes(t);
        if (reminders === null) {
          pending.set(userId, { ...state, prefsStep: 1 });
          await say(`didn't catch that — try "30 min", "1 hour", or "none" for no reminder`);
          return;
        }
        pending.set(userId, { ...state, prefsStep: 2, reminders });
        const reminderStr = reminders.length ? reminders.map(m => m >= 60 ? `${m/60}h` : `${m}min`).join(', ') : 'none';
        await say(`got it — reminder${reminders.length !== 1 ? 's' : ''}: ${reminderStr}. Any default notes to add to every calendar event? (e.g. your phone number, "bring ID", or "none")`);
        return;
      }

      if (step === 2) {
        // Default notes
        const notes = /^(none|no|skip|nah|n\/a|-)$/i.test(t.trim()) ? '' : t.slice(0, 500);
        pending.delete(userId);
        await saveCalendarPrefs({
          duration_minutes: state.duration,
          reminder_minutes: state.reminders,
          default_notes:    notes,
          setup_complete:   true,
        });
        const reminderStr = state.reminders.length
          ? `reminders at ${state.reminders.map(m => m >= 60 ? `${m/60}h` : `${m}min`).join(', ')} before`
          : 'no reminders';
        await say(`saved ✓\n• Event duration: ${state.duration} min\n• ${reminderStr}${notes ? `\n• Default notes: "${notes.slice(0, 60)}"` : ''}\n\nSay *preferences* anytime to update.`);
        return;
      }
    }

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
      // Guard: if user sends a new "remind me to..." message instead of a date (confused state),
      // clear pending and fall through to re-classify as a fresh message
      const looksLikeNewReminder =
        /^(remind me|set a reminder|can you remind|add a reminder)\b/i.test(userText.trim()) &&
        userText.trim().split(/\s+/).length > 5;
      if (!looksLikeNewReminder) {
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
        const date = await parseTimelineToDate(userText) ?? await parseTimelineToDate(userText.replace(/^(on|at|by|this|next)\s+/i, ''));
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

        // Got a valid date — create calendar event with user preferences
        pending.delete(userId);
        const colorId = pickCalendarColor('personal', state.originalText);
        let calCreated = false;
        if (process.env.CALENDAR_ENABLED === 'true') {
          try {
            calCreated = await createCalendarEventWithPrefs({ title: state.reminderTitle, date, colorId, description: state.originalText });
          } catch (err) { console.error('[calendar] event creation failed (network):', err.message); }
        }
        await say(`📅 ${state.reminderTitle} · ${userText.trim()}${calCreated ? ' · added to calendar' : ''}`);
        return;
      }
      // looksLikeNewReminder=true: clear pending and fall through to fresh message processing
      pending.delete(userId);
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
          .trim() || 'Explore';
        // Capitalise first letter; trim ensures no trailing space when topicSlug is empty
        const title = `${verb.charAt(0).toUpperCase() + verb.slice(1)}${topicSlug ? ` ${topicSlug}` : ''}`;
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
          // Reset step to 5 so the next 3 turns allow chat before triggering check-in again at step=8
          pending.set(userId, { ...state, softCheckIn: false, step: 5 });
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

      // User answered "work/personal" AND added a search request (e.g. "personal, but find the date").
      // Save silently and return the search result instead of the app confirmation link.
      const hasSearchAsk = /\b(find|look up|search|when is|what.s the date|what time)\b/i.test(userText);

      if (hasSearchAsk) {
        callInbox({ url: state.url ?? undefined, text: enrichedText, title: state.text ?? undefined, source: 'slack', project })
          .then(data => { if (data?.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary }); })
          .catch(() => {});
        const searchQuery = (state.text ?? '').replace(/^there.?s?\s+(a\s+)?/i, '').trim();
        const searchData  = await webSearch(searchQuery);
        if (searchData?.answer) {
          await say(searchData.answer.slice(0, 500));
        } else if (searchData?.results?.length) {
          const top = searchData.results[0];
          const snippet = (top.content ?? '').slice(0, 300).trim();
          await say(`*${top.title}*\n${snippet}${top.url ? `\n${top.url}` : ''}`);
        } else {
          await say(`couldn't find that — try searching *"${searchQuery.slice(0, 80)}"* on lu.ma`);
        }
        return;
      }

      try {
        const data = await callInbox({ url: state.url ?? undefined, text: enrichedText, title: state.text ?? undefined, source: 'slack', project });
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
  // Pre-AI fast path: explicit learning intent with no URL.
  // Patterns must unambiguously mean "I want to study/understand this topic over time" —
  // NOT information queries ("what is the date", "what time is"), which go to web_search.
  // "tell me about" is also excluded: too broad (e.g. "tell me about the event date").
  const isExplicitLearning =
    urls.length === 0 && (() => {
      const words = userText.trim().split(/\s+/).filter(Boolean).length;
      // Requires explicit learning language AND a topic (word count guards prevent bare triggers)
      if (words > 5 && /\b(want to learn about|want to learn|learning about|i'?m learning about|been learning|trying to learn|i want to understand|i need to understand|need to learn about)\b/i.test(userText)) return true;
      // "explain X to me" pattern — only if no question word in front (avoids "can you explain when...")
      if (words > 4 && /^(can you |could you |please )?(explain)\b/i.test(userText.trim()) && /\bto me\b/i.test(userText)) return true;
      return false;
    })();

  if (isExplicitLearning) {
    pending.set(userId, { learningMode: true, originalText: userText, step: 1, history: [] });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
    return;
  }

  // ── Classify intent — returns array (handles multi-task messages natively) ───
  const tasks = await classifyIntent(userText, urls);

  // Two-pass strategy for multi-task messages:
  // Pass 1: process all tasks that can be completed immediately (no pending state needed).
  //         For reminders: only those WITH a timeline.
  // Pass 2: handle the first task that needs clarification (sets pending, asks question).
  // This ensures "remind me to buy milk, also add assignment for the 13th" correctly
  // adds the assignment to calendar AND asks when to buy milk — instead of stopping at milk.

  const needsInput = []; // tasks deferred to pass 2

  // ── Preferences trigger — handle before task loop ─────────────────────────
  // "preferences", "set preferences", "change settings" etc.
  const wantsPrefs = /\b(preference|preferences|settings|set up|setup|configure|change my)\b/i.test(userText)
    && !/\b(save|remind|add|create)\b/i.test(userText); // don't trigger on "add my preference"
  if (wantsPrefs && tasks.every(t => t.intent === 'converse')) {
    const prefs = await getCalendarPrefs();
    const reminderStr = prefs.reminder_minutes.length
      ? prefs.reminder_minutes.map(m => m >= 60 ? `${m/60}h` : `${m}min`).join(', ')
      : 'none';
    const currentStr = prefs.setup_complete
      ? `Current: ${prefs.duration_minutes} min events, reminders at ${reminderStr}${prefs.default_notes ? `, notes: "${prefs.default_notes.slice(0, 40)}"` : ''}\n\n`
      : '';
    pending.set(userId, { prefsMode: true, prefsStep: 0 });
    await say(`${currentStr}How long should calendar events be by default? (e.g. "30 min", "1 hour", "90 min")`);
    return;
  }

  for (const cls of tasks) {
    if (cls.intent === 'converse') continue;

    if (cls.intent === 'web_search') {
      const query = cls.search_query ?? cls.title ?? userText;
      const searchData = await webSearch(query);
      if (searchData?.answer) {
        await say(searchData.answer.slice(0, 500));
      } else if (searchData?.results?.length) {
        const top = searchData.results[0];
        const snippet = (top.content ?? '').slice(0, 300).trim();
        await say(`*${top.title}*\n${snippet}${top.url ? `\n${top.url}` : ''}`);
      } else {
        await say(`couldn't find anything about "${query.slice(0, 80)}"`);
      }
      continue;
    }

    if (cls.intent === 'correct') {
      const prev = lastSaved.get(userId);
      if (!prev) { await say('nothing recent to correct'); continue; }
      const proj = cls.corrected_project ?? parseProjectFromText(userText);
      if (!proj) {
        needsInput.push({ type: 'correction', prev });
        continue;
      }
      await callCorrect(prev.logId, proj, userText);
      lastSaved.delete(userId);
      await say(`got it — logged as ${proj}`);
      continue;
    }

    if (cls.intent === 'recall') {
      const topic = cls.recall_topic ?? cls.title ?? userText;
      try {
        const res = await fetch(
          `${process.env.APP_URL}/api/inbox/search?q=${encodeURIComponent(topic)}&limit=5`,
          { headers: { 'x-api-secret': process.env.APP_SECRET } },
        );
        const { results } = await res.json();
        if (!results?.length) {
          // If the user was asking for a date/location of an event, try a web search
          const wantsEventDate = /\b(what'?s the date|when is|find the date|date of|where is|what time)\b/i.test(userText);
          if (wantsEventDate) {
            const searchData = await webSearch(topic);
            if (searchData?.answer) {
              await say(searchData.answer.slice(0, 500));
            } else if (searchData?.results?.length) {
              const top = searchData.results[0];
              const snippet = (top.content ?? '').slice(0, 300).trim();
              await say(`*${top.title}*\n${snippet}${top.url ? `\n${top.url}` : ''}`);
            } else {
              await say(`couldn't find anything about "${topic}" — try searching on lu.ma`);
            }
            continue;
          }
          await say(`nothing saved about "${topic}" yet`);
          continue;
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
      continue;
    }

    if (cls.intent === 'reminder') {
      if (cls.timeline) {
        // Has date/time — process immediately, no pending needed
        await processReminderTask(cls, message.channel, userId, say);
      } else {
        // No date — defer to pass 2 (ask "when is X?")
        needsInput.push({ type: 'reminder', cls });
      }
      continue;
    }

    if (cls.intent === 'search_request') {
      pending.set(userId, { url: null, text: cls.title ?? userText, searchMode: true, step: 1 });
      await say('no link — want me to search for the application page? (y/n)');
      break; // pending state set — stop processing remaining tasks until user responds
    }

    // Save — default intent
    if (cls.needs_clarification) {
      pending.set(userId, { url: urls[0] ?? null, text: cls.title ?? userText, step: 1 });
      await say('work or personal?');
      break; // pending state set — stop processing remaining tasks until user responds
    }

    const isVagueLearning = cls.project_hint === 'learning_tech' && urls.length === 0;
    if (isVagueLearning) {
      pending.set(userId, { learningMode: true, originalText: cls.title ?? userText, step: 1, history: [] });
      await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
      break; // pending state set — stop processing remaining tasks until user responds
    }

    const url          = urls[0] ?? undefined;
    const project      = cls.project_hint ?? (cls.context === 'work' ? 'work' : null);
    const enrichedText = buildEnrichedText(cls.context, cls.timeline, cls.title ?? userText, url);

    // Guard: skip save if we have nothing to save (null title + empty enrichedText + empty userText)
    const saveText = enrichedText || cls.title || userText;
    if (!saveText && !url) {
      console.warn('[save] skipped — no text or url to save');
      continue;
    }

    try {
      const data = await callInbox({
        url,
        text:          saveText || undefined,
        title:         cls.title ?? undefined,
        source:        'slack',
        timeline:      cls.timeline      ?? undefined,
        priority_tier: cls.priority_tier ?? undefined,
        ...(project ? { project } : {}),
      });
      if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
      await reply(message.channel, buildSuccessMessage(data, cls));
    } catch {
      await say("couldn't save that");
    }
  }

  // ── Pass 2: handle the first deferred task (needs user input) ─────────────────
  // Only one pending question at a time. Process needsInput[0] if no pending state was set
  // by the loop above. This ensures multi-task messages like "remind me to buy milk,
  // also add assignment for the 13th" correctly process both tasks:
  //   Pass 1: assignment (has timeline) → calendar event created immediately
  //   Pass 2: milk (no timeline) → asks "when is Buy milk?"
  if (needsInput.length > 0 && !pending.has(userId)) {
    const deferred = needsInput[0];
    if (deferred.type === 'reminder') {
      // processReminderTask with no cls.timeline → sets pending + asks "when is X?"
      await processReminderTask(deferred.cls, message.channel, userId, say);
    } else if (deferred.type === 'correction') {
      pending.set(userId, { correctionMode: true, logId: deferred.prev.logId, correctionStep: 0 });
      await say("which project should it be in? (school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal)");
    }
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
