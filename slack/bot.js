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
import { pickColorId } from '../lib/calendar.js';
import { PROJECT_KEYS, VALID_INTENTS, INTENT_SYSTEM_PROMPT } from '../lib/intentPrompt.js';
import { parseContext, parseProjectKey, parseReminderMins, parseDurationMins, parseTodoReply, parseSoftCheckInReply, parseYesNo } from '../lib/naturalParser.js';
import { logCost } from '../lib/costLog.js';
import { Deduplicator } from '../lib/deduplicator.js';
import PendingStore from '../lib/pendingStore.js';
import { loadQuota } from '../lib/geminiQuota.js';
import { classifyTier } from '../lib/tierClassifier.js';
import { compressHistory } from '../lib/conversationManager.js';

const { App } = bolt;

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── AI-powered timeline parser — returns YYYY-MM-DD or full ISO datetime ───────
// Primary: DeepSeek for structured date/time extraction.
// Fallback: chrono-node (handles simple cases without API call).
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
    logCost(result.modelKey, result.usage, { reason: 'timeline_parse' });

    const raw    = result.text?.trim() ?? '';
    const json   = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(json);

    if (parsed.error)    return null;
    if (parsed.datetime) return parsed.datetime;  // ISO datetime — timed calendar event
    if (parsed.date)     return parsed.date;       // date-only — all-day event
    return null;

  } catch (err) {
    console.error('[bot:parseTimelineToDate] AI failed:', err.message, '— chrono-node fallback');
    const { parse: chronoParse } = await import('chrono-node');
    const ref    = new Date();
    const parsed = chronoParse(timeline, ref, { forwardDate: true });
    if (!parsed?.length) return null;
    const p = parsed[0].start;
    const y = p.get('year'), mo = p.get('month'), d = p.get('day');
    const h = p.get('hour') ?? 0, mi = p.get('minute') ?? 0;
    const base = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return (p.isCertain('hour'))
      ? `${base}T${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:00`
      : base;
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
const _dedup = new Deduplicator({ maxSize: 200, ttlSeconds: 90 });
function isDuplicate(message) {
  return _dedup.isDuplicate(message.client_msg_id ?? message.ts);
}

// ── Pending clarification (write-through: in-memory + Supabase via Vercel proxy) ──
const pending = new PendingStore(process.env.APP_URL, process.env.APP_SECRET);

// ── Last saved item per user (for correction flow) ────────────────────────────
// userId → { logId, project, title }
// Expires after 5 minutes — corrections must be immediate
const lastSaved = new Map();
function setLastSaved(userId, data) {
  lastSaved.set(userId, { ...data, at: Date.now() });
  setTimeout(() => lastSaved.delete(userId), 5 * 60 * 1000);
}

// ── AI Intent Classifier ──────────────────────────────────────────────────────
// PROJECT_KEYS, VALID_INTENTS, INTENT_SYSTEM_PROMPT imported from lib/intentPrompt.js

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

    logCost(result.modelKey, result.usage, { reason: 'intent_classification' });

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
  } catch (err) { console.error('[bot:getCalendarPrefs]', err.message); }
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
// deferredQueue: remaining tasks to process after this pending state resolves.
async function processReminderTask(cls, channel, userId, say, deferredQueue = []) {
  const reminderTitle = (cls.title ?? '').trim().slice(0, 60) || 'Reminder';

  if (cls.timeline) {
    const date    = await parseTimelineToDate(cls.timeline);
    const colorId = pickColorId(cls.project_hint ?? 'personal', reminderTitle);
    let calCreated = false;

    if (process.env.CALENDAR_ENABLED === 'true' && date) {
      try {
        calCreated = await createCalendarEventWithPrefs({ title: reminderTitle, date, colorId, description: cls.title ?? reminderTitle });
      } catch (err) { console.error('[calendar] event creation failed (network):', err.message); }
    }
    await reply(channel, `📅 ${reminderTitle} · ${cls.timeline}${calCreated ? ' · added to calendar' : ''}`);
    await processNextDeferred(userId, channel, say, deferredQueue);

  } else {
    pending.set(userId, { reminderMode: true, reminderTitle, originalText: cls.title ?? reminderTitle, deferredQueue });
    await say(`when is "${reminderTitle}"? (or say *to do* to add to your list)`);
  }
}

// Process the next item from the deferred queue after a pending state resolves.
// Shifts the first item and sets a new pending state (or handles it immediately).
async function processNextDeferred(userId, channel, say, queue) {
  if (!queue?.length) return;
  const [next, ...rest] = queue;

  if (next.type === 'reminder') {
    await processReminderTask(next.cls, channel, userId, say, rest);

  } else if (next.type === 'correction') {
    pending.set(userId, { correctionMode: true, logId: next.prev.logId, correctionStep: 0, deferredQueue: rest });
    await say('which project should it be in? (school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal)');

  } else if (next.type === 'search_request') {
    pending.set(userId, { url: null, text: next.cls.title, searchMode: true, step: 1, deferredQueue: rest });
    await say('no link — want me to search for the application page? (y/n)');

  } else if (next.type === 'clarification') {
    pending.set(userId, { clarificationMode: true, url: next.url, text: next.cls.title, step: 1, deferredQueue: rest });
    await say('work or personal?');

  } else if (next.type === 'vague_learning') {
    pending.set(userId, { learningMode: true, originalText: next.cls.title, step: 1, history: [], deferredQueue: rest });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
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
        const mins = await parseDurationMins(t);
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
        const reminders = await parseReminderMins(t);
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
        const SKIP_WORDS = new Set(['none','no','nope','skip','nah','n/a','na','-','nothing','empty','blank']);
        const notes = SKIP_WORDS.has(t.trim().toLowerCase()) ? '' : t.slice(0, 500);
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
        await processNextDeferred(userId, message.channel, say, state.deferredQueue);
        return;
      }
    }

    // Edit mode: user confirming a field update
    if (state.editMode) {
      const yn = await parseYesNo(userText);
      if (yn === 'yes') {
        try {
          if (state.field === 'project_key') {
            await fetch(`${process.env.APP_URL}/api/inbox/correct`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
              body:    JSON.stringify({ itemId: state.matchId, projectKey: state.value }),
            });
          } else {
            await fetch(`${process.env.APP_URL}/api/items/${state.matchId}`, {
              method:  'PATCH',
              headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
              body:    JSON.stringify({ [state.field]: state.value }),
            });
          }
          await say(`updated: *${state.matchTitle}*`);
        } catch (err) {
          console.error('[editMode] patch failed:', err.message);
          await say("couldn't update that item");
        }
      } else {
        await say('ok, nothing changed');
      }
      pending.delete(userId);
      return;
    }

    // Recall more: user asking for next page of recall results
    if (state.recallMore) {
      const wants = /\bmore\b/i.test(userText) || (await parseYesNo(userText)) === 'yes';
      if (wants && state.recallResults?.length) {
        const projectEmoji = {
          personal: '🗓️', learning_tech: '📚', work: '💼', school: '🎓',
          research_apps: '🔬', baking: '🍞', beadwork: '📿', art: '🎨',
          reading: '📖', exercise: '💪', circuitry: '⚡',
        };
        const lines = state.recallResults.map(r => {
          const emoji   = projectEmoji[r.project] ?? '📁';
          const dateStr = r.saved_at ? ` · ${new Date(r.saved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : '';
          const link    = r.url ? `<${r.url}|${r.title}>` : r.title;
          const why     = r._why ? ` — _${r._why}_` : '';
          return `${emoji} ${link}${why}${dateStr}`;
        });
        await say(lines.join('\n'));
      }
      pending.delete(userId);
      return;
    }

    // Correction mode: "which project did you mean?"
    if (state.correctionMode) {
      const proj = await parseProjectKey(userText);
      if (!proj) {
        const reaskCount = (state.correctionStep ?? 0) + 1;
        if (reaskCount >= 2) {
          // Gave up — just confirm it stays where it is
          pending.delete(userId);
          await say(`ok, keeping it as-is`);
          await processNextDeferred(userId, message.channel, say, state.deferredQueue);
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
      await processNextDeferred(userId, message.channel, say, state.deferredQueue);
      return;
    }

    // Reminder date prompt — user is answering "when is this?"
    if (state.reminderMode) {
      const isToDoReply = await parseTodoReply(userText);

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
          await processNextDeferred(userId, message.channel, say, state.deferredQueue);
        } catch (err) { console.error('[bot:reminderMode:todoSave]', err.message); await say("couldn't save that"); }
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
            await processNextDeferred(userId, message.channel, say, state.deferredQueue);
          } catch (err) { console.error('[bot:reminderMode:reaskSave]', err.message); await say("couldn't save that"); }
          return;
        }
        pending.set(userId, { ...state, reminderReask: reask });
        await say(`didn't catch a date — try "this Saturday", "13th", "in 2 weeks", or say *to do* to add to your list`);
        return;
      }

      // Got a valid date — create calendar event with user preferences
      pending.delete(userId);
      const colorId = pickColorId('personal', state.originalText);
      let calCreated = false;
      if (process.env.CALENDAR_ENABLED === 'true') {
        try {
          calCreated = await createCalendarEventWithPrefs({ title: state.reminderTitle, date, colorId, description: state.originalText });
        } catch (err) { console.error('[calendar] event creation failed (network):', err.message); }
      }
      await say(`📅 ${state.reminderTitle} · ${userText.trim()}${calCreated ? ' · added to calendar' : ''}`);
      await processNextDeferred(userId, message.channel, say, state.deferredQueue);
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
          .trim() || 'Explore';
        // Capitalise first letter; trim ensures no trailing space when topicSlug is empty
        const title = `${verb.charAt(0).toUpperCase() + verb.slice(1)}${topicSlug ? ` ${topicSlug}` : ''}`;
        return title.slice(0, 80);
      };

      // ── Soft check-in response: user replied to "shall I save?" prompt ─────
      if (state.softCheckIn) {
        const softReply = await parseSoftCheckInReply(userText);
        if (softReply === 'decline') {
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
          await processNextDeferred(userId, message.channel, say, state.deferredQueue);
        } catch (err) { console.error('[bot:learningMode:softCheckInSave]', err.message); await say("couldn't save that"); }
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
        logCost(classifyResult.modelKey, classifyResult.usage, { reason: 'learning_classify' });
        const raw    = classifyResult.text?.trim() ?? '';
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim());
        classifyType = parsed?.type ?? null;
      } catch (err) {
        console.error('[learningMode] classify call failed:', err.message);
      }

      // ── Decide based on classification ────────────────────────────────────
      if (classifyType === 'action') {
        // Async batch path: longer drafts go to Anthropic Batch API (50% cost, non-blocking)
        const isDraft = /\b(draft|write|outline|summarize|study.?plan|write.?up)\b/i.test(userText);
        if (isDraft && process.env.APP_URL) {
          try {
            await fetch(`${process.env.APP_URL}/api/batch/submit`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
              body:    JSON.stringify({
                jobs: [{
                  system:    `You are a knowledgeable research companion. The user has been exploring: "${state.originalText.slice(0, 150)}". Write a thorough, well-structured response to their request. Use headers and bullet points where appropriate. Be specific and actionable.`,
                  messages:  [...history, { role: 'user', content: userText }],
                  maxTokens: 2000,
                }],
                projectKey:      'learning_tech',
                deliveryUserId:  userId,
                deliveryChannel: message.channel,
              }),
            });
            pending.delete(userId);
            await say(`on it — I'll send you the draft shortly ✦`);
            return;
          } catch (err) {
            console.error('[learningMode] batch submit failed, falling back:', err.message);
            // Fall through to synchronous save path
          }
        }
        saveAsText = userText.trim().slice(0, 60);

      } else if (classifyType === 'chat' && step < 8) {
        // ── Call 2: conversational response — tier-routed for depth ──────────
        const tier = classifyTier(userText, {
          projectKey:  'learning_tech',
          messageCount: step,
          isEscalated:  state.isEscalated ?? false,
        });
        if (tier.tier === 3) console.log(`[bot:learningMode] Tier 3 — ${tier.reason}`);

        // Compress history before Tier 3 (Opus) calls to cap input cost
        const rawHistory = [...history, { role: 'user', content: userText }];
        const callHistory = tier.tier === 3
          ? await compressHistory(rawHistory)
          : rawHistory;

        try {
          const explainResult = await callModelWithFallback(tier.primaryModel, tier.fallbackModel, {
            system: `You are a knowledgeable research companion in an ongoing Slack conversation.
Topic the user is exploring: "${state.originalText.slice(0, 150)}"

Rules:
- Do NOT re-introduce or define the topic from scratch — respond directly to what the user just said.
- Match length to the user's question: short exploratory question → 2-3 sentences max. Detailed technical question → up to 5-6 sentences. Default to shorter.
- Be specific: cite real papers, researchers, findings by name when you know them. Mention them naturally, not as a list.
- Write like a colleague: no "Great question!", no textbook openers, no bullet points, no headers.
- End with a specific observation or question that opens the next line of inquiry. Not a menu of options.
- Plain text only.`,
            messages: callHistory,
            maxTokens: tier.maxTokens,
          });
          logCost(explainResult.modelKey, explainResult.usage, { reason: 'learning_explain' });
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
        const nowEscalated = (tier?.tier ?? 0) === 3;
        pending.set(userId, { ...state, step: step + 1, history: newHistory, isEscalated: nowEscalated }, 14400);
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
        await processNextDeferred(userId, message.channel, say, state.deferredQueue);
      } catch (err) {
        console.error('[bot:learningMode:finalSave]', err.message);
        await say("couldn't save that");
      }
      return;
    }

    // Search mode: "no link — want me to search? (y/n)"
    if (state.searchMode) {
      pending.delete(userId);
      if ((await parseYesNo(userText)) === 'yes') {
        try {
          const data = await callInbox({ text: state.text, source: 'slack', project: 'research_apps' });
          if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
          await reply(message.channel, buildSuccessMessage(data, {}));
          await processNextDeferred(userId, message.channel, say, state.deferredQueue);
        } catch (err) {
          console.error('[bot:searchMode:save]', err.message);
          await say("couldn't save that");
        }
      } else {
        await say('ok, ignored');
        await processNextDeferred(userId, message.channel, say, state.deferredQueue);
      }
      return;
    }

    // Work/personal clarification mode — only when explicitly in this mode
    if (state.clarificationMode) {
      // If they sent a genuinely new URL, abort pending and treat as a fresh message
      const isNewUrl = urls.length > 0 && urls[0] !== state.url;
      if (!isNewUrl) {
        const context = await parseContext(userText);
        if (!context) {
          const reaskCount = (state.clarStep ?? 0) + 1;
          if (reaskCount >= 2) {
            // Can't determine context — save without forcing work/personal
            pending.delete(userId);
            try {
              const data = await callInbox({ url: state.url ?? undefined, text: state.text, source: 'slack' });
              if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
              await reply(message.channel, buildSuccessMessage(data, {}));
              await processNextDeferred(userId, message.channel, say, state.deferredQueue);
            } catch (err) { console.error('[bot:clarificationMode:reaskSave]', err.message); await say('saved ✓'); }
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
        const hasSearchAsk = tasks.some(t => t.intent === 'web_search');

        if (hasSearchAsk) {
          callInbox({ url: state.url ?? undefined, text: enrichedText, title: state.text ?? undefined, source: 'slack', project })
            .then(data => { if (data?.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary }); })
            .catch(err => console.error('[bot:clarificationMode:searchSave]', err.message));
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
          await processNextDeferred(userId, message.channel, say, state.deferredQueue);
        } catch (err) {
          console.error('[bot:clarificationMode:save]', err.message);
          await say("couldn't save that");
        }
        return;
      }

      // New URL arrived → drop pending, fall through to fresh handling
      pending.delete(userId);
    }
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
    } catch (err) {
      console.error('[bot:isPureUrl:save]', err.message);
      await say("couldn't save that");
    }
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
  if (tasks.some(t => t.intent === 'preferences')) {
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

  // ── Edit intent — handle before task loop ────────────────────────────────────
  const editTask = tasks.find(t => t.intent === 'edit');
  if (editTask) {
    const editTitle = editTask.title ?? editTask.recall_topic ?? userText.slice(0, 60);
    try {
      const searchRes = await fetch(
        `${process.env.APP_URL}/api/inbox/search?q=${encodeURIComponent(editTitle)}&limit=5`,
        { headers: { 'x-api-secret': process.env.APP_SECRET } },
      );
      const { results } = await searchRes.json();
      if (!results?.length) {
        await say(`nothing saved matching "${editTitle}"`);
        return;
      }
      const match = results.find(r => r.title?.toLowerCase() === editTitle.toLowerCase()) ?? results[0];
      const field  = editTask.edit_field ?? 'title';
      const value  = editTask.edit_value ?? '';
      const FIELD_LABELS = { due_date: 'deadline', title: 'title', status: 'status',
                             notes: 'notes', project_key: 'project' };
      const fieldLabel = FIELD_LABELS[field] ?? field;
      await say(`Update *${match.title}* — change ${fieldLabel} to "${value}"? (y/n)`);
      pending.set(userId, {
        editMode:   true,
        matchId:    match.id,
        matchTitle: match.title,
        field,
        value,
      }, 300);
    } catch (err) {
      console.error('[editMode] search failed:', err.message);
      await say("couldn't search for that item");
    }
    return;
  }

  for (const cls of tasks) {
    if (cls.intent === 'converse') {
      // Only reply when this is the sole task — mixed converse+save messages don't need ack
      if (tasks.length === 1) {
        await say("I save tasks, links, and set reminders. Try _\"remind me to...\"_ or paste a link.");
      }
      continue;
    }

    if (cls.intent === 'preferences') {
      continue; // handled above before the loop
    }

    if (cls.intent === 'edit') {
      continue; // handled above before the loop
    }

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
      const proj = cls.corrected_project ?? await parseProjectKey(userText);
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
        // Fetch up to 10 — show first 5, stash the rest for "more"
        const res = await fetch(
          `${process.env.APP_URL}/api/inbox/search?q=${encodeURIComponent(topic)}&limit=10`,
          { headers: { 'x-api-secret': process.env.APP_SECRET } },
        );
        const { results: rawResults } = await res.json();
        if (!rawResults?.length) {
          // If the user was asking for a date/location of an event, try a web search
          const wantsEventDate = tasks.some(t => t.intent === 'web_search');
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

        // AI rerank if multiple results — Gemini Flash (free), fire-and-forget on failure
        let results = rawResults;
        if (results.length > 1) {
          try {
            const rankResult = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
              system: `You are a recall assistant. Rank these saved items by relevance to the query and write a 5-10 word reason for each. Return ONLY a JSON array: [{ "id": "...", "title": "...", "why": "..." }] sorted most relevant first. Max 5 items.`,
              messages: [{ role: 'user', content: `Query: "${topic}"\nItems: ${JSON.stringify(results.slice(0, 10).map(r => ({ id: r.id, title: r.title, subtitle: r.subtitle })))}` }],
              maxTokens: 300,
            });
            logCost(rankResult.modelKey, rankResult.usage, { reason: 'recall_rerank' });
            const ranked = JSON.parse(rankResult.text.replace(/```json\n?|```/g, '').trim());
            const reranked = ranked
              .map(r => ({ ...(results.find(x => x.id === r.id) ?? {}), _why: r.why }))
              .filter(r => r.id);
            if (reranked.length) results = reranked;
          } catch { /* keep original order on parse failure */ }
        }

        const PAGE = 5;
        const page1   = results.slice(0, PAGE);
        const overflow = results.slice(PAGE);

        const projectEmoji = {
          personal: '🗓️', learning_tech: '📚', work: '💼', school: '🎓',
          research_apps: '🔬', baking: '🍞', beadwork: '📿', art: '🎨',
          reading: '📖', exercise: '💪', circuitry: '⚡',
        };
        const formatLine = r => {
          const emoji   = projectEmoji[r.project] ?? '📁';
          const dateStr = r.saved_at ? ` · ${new Date(r.saved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : '';
          const link    = r.url ? `<${r.url}|${r.title}>` : r.title;
          const why     = r._why ? ` — _${r._why}_` : '';
          return `${emoji} ${link}${why}${dateStr}`;
        };

        const lines   = page1.map(formatLine);
        const moreStr = overflow.length ? `\n+${overflow.length} more — say *more* to see them` : '';
        await reply(message.channel, `here's what I have on "${topic}":\n${lines.join('\n')}${moreStr}`);

        if (overflow.length) {
          pending.set(userId, { recallMore: true, recallResults: overflow, recallTopic: topic }, 120);
        }
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
      // Defer to pass 2 so all immediate tasks in this message are processed first
      needsInput.push({ type: 'search_request', cls });
      continue;
    }

    // Save — default intent
    if (cls.needs_clarification) {
      // Defer to pass 2 so all immediate tasks in this message are processed first
      needsInput.push({ type: 'clarification', cls, url: urls[0] ?? null });
      continue;
    }

    const isVagueLearning = cls.project_hint === 'learning_tech' && urls.length === 0;
    if (isVagueLearning) {
      // Defer to pass 2 so all immediate tasks in this message are processed first
      needsInput.push({ type: 'vague_learning', cls });
      continue;
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
    } catch (err) {
      console.error('[bot:taskLoop:save]', err.message);
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
    const [first, ...rest] = needsInput;

    if (first.type === 'reminder') {
      await processReminderTask(first.cls, message.channel, userId, say, rest);

    } else if (first.type === 'correction') {
      pending.set(userId, { correctionMode: true, logId: first.prev.logId, correctionStep: 0, deferredQueue: rest });
      await say('which project should it be in? (school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal)');

    } else if (first.type === 'search_request') {
      pending.set(userId, { url: null, text: first.cls.title ?? userText, searchMode: true, step: 1, deferredQueue: rest });
      await say('no link — want me to search for the application page? (y/n)');

    } else if (first.type === 'clarification') {
      pending.set(userId, { clarificationMode: true, url: first.url, text: first.cls.title ?? userText, step: 1, deferredQueue: rest });
      await say('work or personal?');

    } else if (first.type === 'vague_learning') {
      pending.set(userId, { learningMode: true, originalText: first.cls.title ?? userText, step: 1, history: [], deferredQueue: rest });
      await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
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

await loadQuota(process.env.APP_URL, process.env.APP_SECRET);
await pending.hydrateAll();
await app.start();
console.log('✅ Project OS bot running');

// ── Batch draft delivery — poll every 60s for completed async jobs ────────────
if (process.env.APP_URL && process.env.APP_SECRET) {
  setInterval(async () => {
    try {
      const res = await fetch(`${process.env.APP_URL}/api/batch/poll`, {
        headers: { 'x-api-secret': process.env.APP_SECRET },
      });
      const { completed } = await res.json();
      for (const { text, channel } of (completed ?? [])) {
        await app.client.chat.postMessage({ channel, text });
        console.log(`[batch:poll] delivered draft to ${channel}`);
      }
    } catch (err) {
      console.error('[batch:poll] poll failed:', err.message);
    }
  }, 60_000);
}
