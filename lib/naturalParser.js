/**
 * Natural Language Parsers — AI-first, regex fallback.
 *
 * Every function here replaces a fragile regex-only parser in bot.js.
 * Pattern: try a cheap AI call (gemini-flash, maxTokens: 20-30) → fall back to
 * regex/heuristic if the AI call fails or returns garbage.
 *
 * This is the same architecture as parseTimelineToDate in bot.js.
 * All functions are async, never throw, and always return a valid value.
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

  } catch {
    // Fallback: regex (same as old parseClarificationContext)
    if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(t)) return 'work';
    if (/\bpersonal\b|\bmine\b|\bfun\b|\bcurious\b|\blearning\b/i.test(t)) return 'personal';
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

  } catch {
    // Fallback: substring alias table (old behaviour)
    return _projectFromAliases(text);
  }
}

// Alias fallback (kept as-is for the catch path — not removed, just demoted)
const _PROJECT_ALIASES = {
  'personal': 'personal',
  'school': 'school',       'uni': 'school',       'university': 'school',
  'work': 'work',           'job': 'work',
  'research': 'research_apps', 'applications': 'research_apps', 'apps': 'research_apps',
  'learning': 'learning_tech', 'tech': 'learning_tech', 'learn': 'learning_tech',
  'circuits': 'circuitry',  'electronics': 'circuitry',  'arduino': 'circuitry',
  'baking': 'baking',       'bread': 'baking',
  'beads': 'beadwork',      'beadwork': 'beadwork',       'jewelry': 'beadwork',
  'art': 'art',             'drawing': 'art',             'pastels': 'art',
  'reading': 'reading',     'books': 'reading',
  'exercise': 'exercise',   'gym': 'exercise',            'fitness': 'exercise',
};
function _projectFromAliases(text) {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [alias, key] of Object.entries(_PROJECT_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
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

  } catch {
    // Fallback: original regex parser
    return _parseReminderMinutesRegex(t);
  }
}

function _parseReminderMinutesRegex(t) {
  const low = t.toLowerCase();
  if (/\b(none|no|off|never|skip)\b/.test(low)) return [];
  const hourMatch = low.match(/(\d+)\s*h(our)?/);
  const minMatch  = low.match(/(\d+)\s*m(in)?/);
  const bareNum   = low.match(/^(\d+)$/);
  const reminders = [];
  if (hourMatch) reminders.push(parseInt(hourMatch[1]) * 60);
  if (minMatch)  reminders.push(parseInt(minMatch[1]));
  if (bareNum && !hourMatch && !minMatch) reminders.push(parseInt(bareNum[1]));
  return reminders.length ? reminders : null;
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

  } catch {
    // Fallback: original regex parser
    return _parseDurationMinutesRegex(t);
  }
}

function _parseDurationMinutesRegex(t) {
  const low = t.toLowerCase();
  const hourMatch = low.match(/(\d+)\s*h(our)?/);
  const minMatch  = low.match(/(\d+(?:\.\d+)?)\s*m(in)?/);
  const bareNum   = low.match(/^(\d+)$/);
  if (hourMatch) return parseInt(hourMatch[1]) * 60 + (minMatch ? parseInt(minMatch[1]) : 0);
  if (minMatch)  return parseInt(minMatch[1]);
  if (bareNum)   return parseInt(bareNum[1]);
  return null;
}
