/**
 * Natural Language Parsers — AI-first, no regex fallback.
 *
 * Every function here calls a cheap AI model (gemini-flash, maxTokens: 15-30).
 * On failure: return null (caller handles re-ask or fallback behaviour).
 * No regex for semantic decisions.
 */

import { callModelWithFallback } from './multiModelClient.js';
import { PROJECT_KEYS } from './intentPrompt.js';
import { logCostViaApi } from './vmCostLogger.js';

// ── Shared JSON extraction helper ─────────────────────────────────────────────
function extractJson(raw) {
  return raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
}


// ── parseContext ──────────────────────────────────────────────────────────────
// Used when bot asks "work or personal?" — parse the user's reply.
// Returns: "work" | "personal" | null
//
// Regex fallback handles: bare "w"/"p", clear keywords.
// AI handles: "it's mine for job stuff", "learning for fun", "professional thing", etc.
// ─────────────────────────────────────────────────────────────────────────────
export async function parseContext(text) {
  const t = text.trim();

  // Fast-path: single char initials — unambiguous, no AI needed
  if (/^w\.?$/i.test(t)) return 'work';
  if (/^p\.?$/i.test(t)) return 'personal';

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `Classify whether this message indicates "work" or "personal" context.

work = professional, job, career, sprint, ticket, office, employer, business
personal = personal life, hobby, learning for yourself, appointment, errands, fun, curious

Return ONLY valid JSON, nothing else:
{"context": "work"} or {"context": "personal"} or {"context": null}

null = genuinely cannot tell from this message alone.`,
      messages: [{ role: 'user', content: t }],
      maxTokens: 20,
    });
    logCostViaApi(result.modelKey, result.usage, 'parse_context');

    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    const ctx = parsed?.context ?? null;
    if (ctx === 'work' || ctx === 'personal') return ctx;
    return null;

  } catch (err) {
    console.error('[naturalParser:parseContext] AI failed:', err.message);
    return null;
  }
}


// ── parseProjectKey ───────────────────────────────────────────────────────────
// Used in correction mode — user says which project to move a task to.
// Returns: one of PROJECT_KEYS or null.
//
// The old alias table had collision bugs (e.g. "beadwork" → 'work') and rejected
// natural phrasing like "art history stuff" or "my circuit project".
// ─────────────────────────────────────────────────────────────────────────────
export async function parseProjectKey(text) {
  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `Identify which project category the user is referring to.

Valid categories:
- personal: appointments, errands, life admin
- school: coursework, exams, university
- work: job tasks, sprints, professional tickets
- research_apps: fellowships, grants, PhD applications
- learning_tech: papers, ML, programming, repos
- baking: recipes, bread, food
- beadwork: jewelry, beads, craft
- art: drawing, painting, pastels
- reading: books, essays, reading lists
- exercise: gym, sport, fitness
- circuitry: Arduino, PCB, electronics

Return ONLY valid JSON, nothing else: {"project": "<category>"} or {"project": null} if unclear.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 25,
    });

    logCostViaApi(result.modelKey, result.usage, 'parse_project_key');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    const proj = parsed?.project ?? null;
    return PROJECT_KEYS.includes(proj) ? proj : null;

  } catch (err) {
    console.error('[naturalParser:parseProjectKey] AI failed:', err.message);
    return null;
  }
}


// ── parseReminderMins ─────────────────────────────────────────────────────────
// Used in prefs setup: "how long before should I remind you?"
// Returns: number[] (array of minutes) | [] (no reminder) | null (re-ask)
//
// Old regex rejected: "half an hour", "an hour", "two hours", "1.5 hours"
// AI handles all natural language time expressions.
// ─────────────────────────────────────────────────────────────────────────────
export async function parseReminderMins(text) {
  const t = text.trim();

  // Fast-path: explicit no-reminder words — unambiguous
  if (/\b(none|no|off|never|skip|nope|nah|zero)\b/i.test(t)) return [];

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `Convert this reminder time into minutes as an integer array.

Examples:
"30 min" → {"minutes": [30]}
"1 hour" → {"minutes": [60]}
"an hour" → {"minutes": [60]}
"half an hour" → {"minutes": [30]}
"45 minutes" → {"minutes": [45]}
"two hours" → {"minutes": [120]}
"1.5 hours" → {"minutes": [90]}
"1 hour 30 min" → {"minutes": [60, 30]}
"2h 15m" → {"minutes": [120, 15]}
"15" → {"minutes": [15]}
"none" → {"minutes": []}

Return ONLY valid JSON: {"minutes": [integers...]} or {"minutes": null} if completely unparseable.`,
      messages: [{ role: 'user', content: t }],
      maxTokens: 30,
    });

    logCostViaApi(result.modelKey, result.usage, 'parse_reminder_mins');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    if (parsed?.minutes === null) return null;
    if (Array.isArray(parsed?.minutes)) return parsed.minutes;
    return null;

  } catch (err) {
    console.error('[naturalParser:parseReminderMins] AI failed:', err.message);
    return null;
  }
}


// ── parseDurationMins ─────────────────────────────────────────────────────────
// Used in prefs setup: "how long should calendar events be?"
// Returns: number (minutes) | null (re-ask)
//
// Old regex rejected: "an hour", "half an hour", "one hour", "1.5 hours"
// ─────────────────────────────────────────────────────────────────────────────
export async function parseDurationMins(text) {
  const t = text.trim();

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `Convert this duration into a single integer number of minutes.

Examples:
"30 min" → {"minutes": 30}
"1 hour" → {"minutes": 60}
"an hour" → {"minutes": 60}
"half an hour" → {"minutes": 30}
"1.5 hours" → {"minutes": 90}
"one hour" → {"minutes": 60}
"two hours" → {"minutes": 120}
"90 min" → {"minutes": 90}
"45" → {"minutes": 45}
"1h30m" → {"minutes": 90}
"2h 15min" → {"minutes": 135}

Return ONLY valid JSON: {"minutes": integer} or {"minutes": null} if completely unparseable.`,
      messages: [{ role: 'user', content: t }],
      maxTokens: 25,
    });

    logCostViaApi(result.modelKey, result.usage, 'parse_duration_mins');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    if (typeof parsed?.minutes === 'number' && Number.isFinite(parsed.minutes)) {
      return Math.round(parsed.minutes);
    }
    return null;

  } catch (err) {
    console.error('[naturalParser:parseDurationMins] AI failed:', err.message);
    return null;
  }
}


// ── parseTodoReply ─────────────────────────────────────────────────────────────
// Used when bot asks "when is X?" — detect if user wants to save to to-do (no date).
// Returns: true | false | null (re-ask)
// ─────────────────────────────────────────────────────────────────────────────
export async function parseTodoReply(text) {
  const t = text.trim().toLowerCase();

  // Fast-path: closed structural set — no AI needed
  const TODO_WORDS = new Set(['td', 'todo', 'to-do', 'to do']);
  if (TODO_WORDS.has(t)) return true;

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `The bot asked "when is this?" and the user replied. Decide if the reply means they want to skip the date and add it to a to-do list instead.

true = user wants no date / to-do / kanban (e.g. "just add it", "no date", "to do list", "whenever", "my list", "add to list", "no specific date")
false = user is giving a date or time, or talking about something else
null = genuinely unclear

Return ONLY valid JSON: {"todo": true} or {"todo": false} or {"todo": null}`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 15,
    });
    logCostViaApi(result.modelKey, result.usage, 'parse_todo_reply');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    return parsed?.todo ?? null;
  } catch (err) {
    console.error('[naturalParser:parseTodoReply] AI failed:', err.message);
    return null;
  }
}


// ── parseSoftCheckInReply ─────────────────────────────────────────────────────
// Used when bot asks "want me to save something?" (soft check-in in learningMode).
// Returns: "decline" | "accept" | null
// ─────────────────────────────────────────────────────────────────────────────
export async function parseSoftCheckInReply(text) {
  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `The bot asked "want me to save something?" and the user replied. Classify their response.

decline = user says no / not yet / keep going (e.g. "no", "nah", "not yet", "keep going", "continue", "later", "nope")
accept = user says yes or describes what to save (anything else)

Return ONLY valid JSON: {"reply": "decline"} or {"reply": "accept"}`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 15,
    });
    logCostViaApi(result.modelKey, result.usage, 'parse_soft_checkin');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    const r = parsed?.reply;
    return (r === 'decline' || r === 'accept') ? r : null;
  } catch (err) {
    console.error('[naturalParser:parseSoftCheckInReply] AI failed:', err.message);
    return null;
  }
}


// ── parseYesNo ────────────────────────────────────────────────────────────────
// Used in searchMode: bot asks "want me to search? (y/n)".
// Returns: "yes" | "no" | null
// ─────────────────────────────────────────────────────────────────────────────
export async function parseYesNo(text) {
  const t = text.trim().toLowerCase();

  // Fast-path: closed structural set — unambiguous single tokens
  const YES = new Set(['y', 'yes', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay']);
  const NO  = new Set(['n', 'no', 'nah', 'nope', 'nop']);
  if (YES.has(t)) return 'yes';
  if (NO.has(t))  return 'no';

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system: `Classify whether this message means yes or no.

Return ONLY valid JSON: {"answer": "yes"} or {"answer": "no"} or {"answer": null} if genuinely unclear.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 15,
    });
    logCostViaApi(result.modelKey, result.usage, 'parse_yes_no');
    const parsed = JSON.parse(extractJson(result.text?.trim() ?? ''));
    const a = parsed?.answer;
    return (a === 'yes' || a === 'no') ? a : null;
  } catch (err) {
    console.error('[naturalParser:parseYesNo] AI failed:', err.message);
    return null;
  }
}
