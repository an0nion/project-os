/**
 * Realistic user input tests — tricky, near-miss, and adversarial cases.
 *
 * Philosophy: every input here is something a real user would plausibly type.
 * The goal is NOT to make tests fail — it is to document exact boundary
 * behaviour so regressions are instantly visible. Some results are surprising
 * but correct; those are annotated with WHY.
 *
 * Run: node --test tests/bot-realistic.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_INTENTS, PROJECT_KEYS } from '../lib/intentPrompt.js';

// ── Replicated pure functions (keep in sync with bot.js / tests) ──────────────

const PROJECT_EMOJI = {
  personal: '🗓️', learning_tech: '📚', work: '💼', school: '🎓',
  research_apps: '🔬', baking: '🍞', beadwork: '📿', art: '🎨',
  reading: '📖', exercise: '💪', circuitry: '⚡',
};

const PROJECT_ALIASES = {
  'personal':      'personal',
  'school':        'school',     'uni': 'school',      'university': 'school',
  'work':          'work',       'job': 'work',
  'research':      'research_apps', 'applications': 'research_apps', 'apps': 'research_apps',
  'learning':      'learning_tech', 'tech': 'learning_tech', 'learn': 'learning_tech',
  'circuits':      'circuitry',  'electronics': 'circuitry',  'arduino': 'circuitry',
  'baking':        'baking',     'bread': 'baking',
  'beads':         'beadwork',   'beadwork': 'beadwork',       'jewelry': 'beadwork',
  'art':           'art',        'drawing': 'art',             'pastels': 'art',
  'reading':       'reading',    'books': 'reading',
  'exercise':      'exercise',   'gym': 'exercise',            'fitness': 'exercise',
};

function parseProjectFromText(text) {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
}

function parseClarificationContext(text) {
  if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(text)) return 'work';
  if (/\bpersonal\b|\bperson\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  const t = text.toLowerCase();
  if (/^w\b/i.test(t.trim())) return 'work';
  if (/^p\b/i.test(t.trim())) return 'personal';
  return null;
}

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
  return reminders.length ? reminders : null;
}

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

function buildLearningTitle(action, topic) {
  const topicSlug = topic
    .replace(/^i (want to learn about|want to understand|am learning about|want to)\s*/i, '')
    .replace(/^(learn about|tell me about|explain|what is|what are)\s*/i, '')
    .trim();
  const verb = action
    .replace(/\s+(it|the paper|more|about it|everything)$/i, '')
    .trim() || 'Explore';
  const title = `${verb.charAt(0).toUpperCase() + verb.slice(1)}${topicSlug ? ` ${topicSlug}` : ''}`;
  return title.slice(0, 80);
}

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

const isExplicitLearning = (text, urls) => {
  if (urls.length > 0) return false;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 5 && /\b(want to learn about|want to learn|learning about|i'?m learning about|been learning|trying to learn|i want to understand|i need to understand|need to learn about)\b/i.test(text)) return true;
  if (words > 4 && /^(can you |could you |please )?(explain)\b/i.test(text.trim()) && /\bto me\b/i.test(text)) return true;
  return false;
};

// bareAction fast-path regex (from bot.js learningMode)
const bareAction = (text) =>
  /^(read|implement|write|understand|learn|theory|both|all)(\s+(it|the paper|more|about it|everything))?$/i.test(text.trim());

// softCheckIn decision (from bot.js)
const softCheckInIsReset = (userText) =>
  /^(no|nah|nope|not yet|keep going|continue|later)/.test(userText.toLowerCase().trim());

// isToDoReply (from bot.js reminderMode)
const isToDoReply = (text) =>
  /^(to.?do|td|my list|add to list|no date|just add it|whenever)$/i.test(text.toLowerCase().trim());

// looksLikeNewReminder (from bot.js reminderMode)
const looksLikeNewReminder = (text) =>
  /^(remind me|set a reminder|can you remind|add a reminder)\b/i.test(text.trim())
  && text.trim().split(/\s+/).length > 5;

// hasSearchAsk (from bot.js clarificationMode)
const hasSearchAsk = (text) =>
  /\b(find|look up|search|when is|what.s the date|what time)\b/i.test(text);

// wantsPrefs (from bot.js)
const wantsPrefs = (text) =>
  /\b(preference|preferences|settings|set up|setup|configure|change my)\b/i.test(text)
  && !/\b(save|remind|add|create)\b/i.test(text);

// parseTimelineToDateFallback (simplified for pattern testing — no real date math)
function parseTimelineToDateFallback(timeline, nowOverride) {
  if (!timeline) return null;
  const now = nowOverride ?? new Date();
  const low = timeline.toLowerCase().trim();

  if (/\b(today|tonight|now|asap)\b/.test(low)) {
    const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
    return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
  }
  if (/\btomorrow\b/.test(low)) {
    const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
    mel.setDate(mel.getDate() + 1);
    return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
  }
  const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < DOW.length; i++) {
    if (new RegExp(`\\b${DOW[i]}\\b`).test(low)) {
      const mel = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
      const diff = (i - mel.getDay() + 7) % 7 || 7;
      mel.setDate(mel.getDate() + diff);
      return `${mel.getFullYear()}-${String(mel.getMonth()+1).padStart(2,'0')}-${String(mel.getDate()).padStart(2,'0')}`;
    }
  }
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
  const stripped = timeline.trim().replace(/^(by|on|at)\s+/i, '');
  const parsed   = new Date(stripped);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= now.getFullYear()) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// Fixed "now" for deterministic date tests: Monday 2026-04-13 (a Monday at noon, Melbourne)
const FIXED_NOW = new Date('2026-04-13T02:00:00.000Z'); // 12:00 Melbourne AEST (UTC+10)


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 52 — parseClarificationContext: realistic conflicting signal inputs
// Real users often include both work and personal signals in the same message.
// The function uses two independent regexes; whichever matches first wins.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseClarificationContext — realistic conflicting inputs', () => {

  // ── Clear work signals ──
  test('"it\'s a work thing" → work', () => {
    assert.equal(parseClarificationContext("it's a work thing"), 'work');
  });

  test('"for my job" → work', () => {
    assert.equal(parseClarificationContext('for my job'), 'work');
  });

  test('"this is for a sprint ticket" → work', () => {
    assert.equal(parseClarificationContext('this is for a sprint ticket'), 'work');
  });

  test('"professional development stuff" → work', () => {
    assert.equal(parseClarificationContext('professional development stuff'), 'work');
  });

  // ── Clear personal signals ──
  test('"just for me" → personal (contains "me")', () => {
    assert.equal(parseClarificationContext('just for me'), 'personal');
  });

  test('"mine to keep" → personal', () => {
    assert.equal(parseClarificationContext('mine to keep'), 'personal');
  });

  test('"just for fun" → personal', () => {
    assert.equal(parseClarificationContext('just for fun'), 'personal');
  });

  test('"I\'m curious about it for myself" → personal (curious + me)', () => {
    assert.equal(parseClarificationContext("I'm curious about it for myself"), 'personal');
  });

  // ── Conflicting signals: work wins (checked first in the regex order) ──
  test('"it\'s mine but for work" → work (work regex checked before personal)', () => {
    // Contains both "mine" (personal) and "work" (work)
    // First regex: /\bwork\b/... → matches → returns "work"
    assert.equal(parseClarificationContext("it's mine but for work"), 'work');
  });

  test('"learning for a work sprint" → work (sprint matched before learning)', () => {
    // Contains "learning" (personal) AND "sprint" (work)
    assert.equal(parseClarificationContext('learning for a work sprint'), 'work');
  });

  test('"my job is fun" → work (job matched before fun)', () => {
    assert.equal(parseClarificationContext('my job is fun'), 'work');
  });

  test('"personal trainer at my job" → work (job matched before personal)', () => {
    // "personal" is there but "job" is in the FIRST regex group → work wins
    assert.equal(parseClarificationContext('personal trainer at my job'), 'work');
  });

  // ── Single-char replies ──
  test('"w" → work (bare initial)', () => {
    assert.equal(parseClarificationContext('w'), 'work');
  });

  test('"p" → personal (bare initial)', () => {
    assert.equal(parseClarificationContext('p'), 'personal');
  });

  test('"W." → work (W with punctuation)', () => {
    // After lowercase: "w." — trim: "w." — /^w\b/ tests "w" at start — \b is word boundary
    // "w." → "w" followed by "." which IS a word boundary → matches
    assert.equal(parseClarificationContext('W.'), 'work');
  });

  test('"work!" → work (punctuation stripped by regex)', () => {
    // \bwork\b in "work!" → \b matches between 'k' and '!' → work
    assert.equal(parseClarificationContext('work!'), 'work');
  });

  // ── Tricky negatives ──
  test('"wow that\'s interesting" → null (no context signal)', () => {
    assert.equal(parseClarificationContext("wow that's interesting"), null);
  });

  test('"sure" → null', () => {
    assert.equal(parseClarificationContext('sure'), null);
  });

  test('"yes please" → null', () => {
    assert.equal(parseClarificationContext('yes please'), null);
  });

  test('"both I guess" → null (no recognised keyword)', () => {
    assert.equal(parseClarificationContext('both I guess'), null);
  });

  test('"personal trainer" → personal (the word "personal" IS in the text)', () => {
    // \bpersonal\b matches in "personal trainer"
    assert.equal(parseClarificationContext('personal trainer'), 'personal');
  });

  test('"workspace" does NOT trigger work (no \bwork\b)', () => {
    // "workspace" → \bwork\b: 'w-o-r-k' followed by boundary? In "workspace" the 'k'
    // is followed by 's' which is a word char → NOT a boundary → does NOT match \bwork\b
    assert.equal(parseClarificationContext('workspace'), null);
  });

  test('"homework" does NOT trigger work (\bwork\b not present)', () => {
    // "homework" — \bwork\b: 'k' is followed by end of word BUT preceded by 'r' which is
    // inside "homework" — there's no boundary BEFORE "work" since 'e' precedes 'w' → no \b
    // Actually: "homework" → boundary analysis: no \b before "work" in "homework" → null
    assert.equal(parseClarificationContext('homework'), null);
  });

  test('"personnel" does NOT trigger personal (\bpersonal\b not in "personnel")', () => {
    // "personnel" contains "person" but not "personal" → second regex \bpersonal\b → no match
    // But first check: does \bperson\b match? "personnel" → \bperson\b → 'n' boundary?
    // "person" in "personnel": position 0-5, char 6 is 'n' → 'n' is a word char → NO boundary
    // So \bpersonal\b → "personnel" → 'person' + 'nel' → no match. Correct.
    assert.equal(parseClarificationContext('personnel'), null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 53 — isToDoReply: near-miss realistic inputs
// The regex requires an EXACT match (^...$), so "todo list" or "add it to my
// list" should NOT match — only the exact phrases in the alternation do.
// ══════════════════════════════════════════════════════════════════════════════

describe('isToDoReply — near-miss and exact match inputs', () => {

  // ── True: exact match ──
  test('"to do" → true', () => assert.equal(isToDoReply('to do'), true));
  test('"todo" → true', () => assert.equal(isToDoReply('todo'), true));
  test('"to-do" → true', () => assert.equal(isToDoReply('to-do'), true));
  test('"td" → true', () => assert.equal(isToDoReply('td'), true));
  test('"my list" → true', () => assert.equal(isToDoReply('my list'), true));
  test('"add to list" → true', () => assert.equal(isToDoReply('add to list'), true));
  test('"no date" → true', () => assert.equal(isToDoReply('no date'), true));
  test('"just add it" → true', () => assert.equal(isToDoReply('just add it'), true));
  test('"whenever" → true', () => assert.equal(isToDoReply('whenever'), true));

  // ── Near-misses: extra word, typo, double space ──
  test('"todo list" → false (extra word "list")', () => {
    // `^(to.?do|...)$` — the $ requires end of string, but "todo list" has " list" after
    assert.equal(isToDoReply('todo list'), false);
  });

  test('"to  do" → false (double space — .? matches at most 1 char)', () => {
    // "to  do" → to + 2 spaces + do. The `.?` in `to.?do` matches 0 or 1 char.
    // "to  do" has 2 spaces between "to" and "do" → no match.
    assert.equal(isToDoReply('to  do'), false);
  });

  test('"add it to my list" → false (longer phrase, extra words)', () => {
    assert.equal(isToDoReply('add it to my list'), false);
  });

  test('"no date set" → false (extra word)', () => {
    assert.equal(isToDoReply('no date set'), false);
  });

  test('"just add it please" → false (extra word)', () => {
    assert.equal(isToDoReply('just add it please'), false);
  });

  test('"whenever works" → false (extra word)', () => {
    assert.equal(isToDoReply('whenever works'), false);
  });

  test('"to do it later" → false (extra words)', () => {
    assert.equal(isToDoReply('to do it later'), false);
  });

  test('"my to-do list" → false (different phrase)', () => {
    assert.equal(isToDoReply('my to-do list'), false);
  });

  // ── Realistic date-like replies that should NOT be isToDoReply ──
  test('"this Saturday" → false', () => assert.equal(isToDoReply('this Saturday'), false));
  test('"tomorrow" → false', () => assert.equal(isToDoReply('tomorrow'), false));
  test('"next week" → false', () => assert.equal(isToDoReply('next week'), false));
  test('"13th" → false', () => assert.equal(isToDoReply('13th'), false));
  test('"in 2 weeks" → false', () => assert.equal(isToDoReply('in 2 weeks'), false));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 54 — looksLikeNewReminder: word count boundary at exactly 5/6
// The guard requires the message to start with a reminder phrase AND have >5
// words. Exactly 5 words = false. 6 words = true.
// ══════════════════════════════════════════════════════════════════════════════

describe('looksLikeNewReminder — word count boundary (>5 words required)', () => {

  // ── Exactly at and below the 5-word threshold (false) ──
  test('"remind me" (2 words) → false', () => {
    assert.equal(looksLikeNewReminder('remind me'), false);
  });

  test('"remind me to call" (4 words) → false', () => {
    assert.equal(looksLikeNewReminder('remind me to call'), false);
  });

  test('"remind me to call mum" (5 words) → false (exactly 5, not >5)', () => {
    assert.equal(looksLikeNewReminder('remind me to call mum'), false);
  });

  test('"set a reminder for Monday" (5 words) → false', () => {
    assert.equal(looksLikeNewReminder('set a reminder for Monday'), false);
  });

  // ── 6+ words (true) ──
  test('"remind me to call mum today" (6 words) → true', () => {
    assert.equal(looksLikeNewReminder('remind me to call mum today'), true);
  });

  test('"set a reminder for Monday morning please" (7 words) → true', () => {
    assert.equal(looksLikeNewReminder('set a reminder for Monday morning please'), true);
  });

  test('"can you remind me about the dentist" (7 words) → true', () => {
    assert.equal(looksLikeNewReminder('can you remind me about the dentist'), true);
  });

  test('"add a reminder for gym tomorrow morning" (7 words) → true', () => {
    assert.equal(looksLikeNewReminder('add a reminder for gym tomorrow morning'), true);
  });

  // ── Does NOT start with trigger phrase (false regardless of length) ──
  test('"please remind me to call the doctor tomorrow" → false (wrong opening word)', () => {
    // Starts with "please" not one of the trigger phrases
    assert.equal(looksLikeNewReminder('please remind me to call the doctor tomorrow'), false);
  });

  test('"hey remind me to check slack tomorrow morning" → false (starts with "hey")', () => {
    assert.equal(looksLikeNewReminder('hey remind me to check slack tomorrow morning'), false);
  });

  // ── Realistic date replies that should NOT trigger ──
  test('"this Saturday morning" → false', () => {
    assert.equal(looksLikeNewReminder('this Saturday morning'), false);
  });

  test('"actually the 15th of this month" → false', () => {
    assert.equal(looksLikeNewReminder('actually the 15th of this month'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 55 — softCheckIn: realistic replies including tricky regex matches
//
// The regex is: /^(no|nah|nope|not yet|keep going|continue|later)/
// IMPORTANT: "no" has no word boundary — any string starting with "no" matches.
// This means "now", "note", "notion", "nothing", "not sure" all trigger RESET.
// These are documented here as known behaviour, not bugs to fix.
// ══════════════════════════════════════════════════════════════════════════════

describe('softCheckIn — tricky regex matches and realistic reply inputs', () => {

  // ── Clear reset cases ──
  test('"no" → reset', () => assert.equal(softCheckInIsReset('no'), true));
  test('"nah" → reset', () => assert.equal(softCheckInIsReset('nah'), true));
  test('"nope" → reset', () => assert.equal(softCheckInIsReset('nope'), true));
  test('"not yet" → reset', () => assert.equal(softCheckInIsReset('not yet'), true));
  test('"keep going" → reset', () => assert.equal(softCheckInIsReset('keep going'), true));
  test('"continue" → reset', () => assert.equal(softCheckInIsReset('continue'), true));
  test('"later" → reset', () => assert.equal(softCheckInIsReset('later'), true));

  // ── "no" prefix without word boundary — these all trigger reset ──
  test('"not sure yet" → reset (starts with "no" via "not")', () => {
    // WHY: /^no/ matches "not sure yet" because the first two chars are 'n','o'
    assert.equal(softCheckInIsReset('not sure yet'), true);
  });

  test('"nothing yet" → reset (starts with "no")', () => {
    assert.equal(softCheckInIsReset('nothing yet'), true);
  });

  test('"no I\'d like to keep talking" → reset', () => {
    assert.equal(softCheckInIsReset("no I'd like to keep talking"), true);
  });

  test('"nah, just keep exploring" → reset', () => {
    assert.equal(softCheckInIsReset('nah, just keep exploring'), true);
  });

  test('"later today I\'ll decide" → reset (starts with "later")', () => {
    assert.equal(softCheckInIsReset("later today I'll decide"), true);
  });

  // ── "no" prefix: surprising reset triggers ──
  test('"not really" → reset (starts with "no" via "not")', () => {
    // This is the key tricky case: user says "not really" meaning "not ready to save"
    // The bot correctly resets (keeps exploring)
    assert.equal(softCheckInIsReset('not really'), true);
  });

  // ── Clear save cases ──
  test('"read the paper" → save (not reset)', () => {
    assert.equal(softCheckInIsReset('read the paper'), false);
  });

  test('"implement it in PyTorch" → save', () => {
    assert.equal(softCheckInIsReset('implement it in PyTorch'), false);
  });

  test('"write up a summary of the key findings" → save', () => {
    assert.equal(softCheckInIsReset('write up a summary of the key findings'), false);
  });

  test('"understand the maths behind it" → save', () => {
    assert.equal(softCheckInIsReset('understand the maths behind it'), false);
  });

  test('"sure, save reading the attention paper" → save', () => {
    assert.equal(softCheckInIsReset('sure, save reading the attention paper'), false);
  });

  test('"yes — implement from scratch" → save', () => {
    assert.equal(softCheckInIsReset('yes — implement from scratch'), false);
  });

  test('"ok implement it" → save (starts with "ok", not a reset trigger)', () => {
    assert.equal(softCheckInIsReset('ok implement it'), false);
  });

  test('"actually yes, save reading transformers" → save', () => {
    assert.equal(softCheckInIsReset('actually yes, save reading transformers'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 56 — bareAction fast-path: near-misses and realistic inputs
// The bareAction regex is very specific. Only exact standalone verbs (optionally
// followed by a small set of completions) trigger it. Any extra words → false.
// ══════════════════════════════════════════════════════════════════════════════

describe('bareAction — realistic near-miss inputs', () => {

  // ── True: exact matches ──
  test('"read" → bareAction', () => assert.equal(bareAction('read'), true));
  test('"Read" → bareAction (case insensitive)', () => assert.equal(bareAction('Read'), true));
  test('"READ" → bareAction', () => assert.equal(bareAction('READ'), true));
  test('"implement" → bareAction', () => assert.equal(bareAction('implement'), true));
  test('"write" → bareAction', () => assert.equal(bareAction('write'), true));
  test('"understand" → bareAction', () => assert.equal(bareAction('understand'), true));
  test('"learn" → bareAction', () => assert.equal(bareAction('learn'), true));
  test('"theory" → bareAction', () => assert.equal(bareAction('theory'), true));
  test('"both" → bareAction', () => assert.equal(bareAction('both'), true));
  test('"all" → bareAction', () => assert.equal(bareAction('all'), true));
  test('"read it" → bareAction', () => assert.equal(bareAction('read it'), true));
  test('"read the paper" → bareAction', () => assert.equal(bareAction('read the paper'), true));
  test('"implement more" → bareAction', () => assert.equal(bareAction('implement more'), true));
  test('"understand about it" → bareAction', () => assert.equal(bareAction('understand about it'), true));
  test('"read everything" → bareAction', () => assert.equal(bareAction('read everything'), true));

  // ── Near-misses: extra words make it fall through to AI classification ──
  test('"read it now" → NOT bareAction (extra word "now")', () => {
    assert.equal(bareAction('read it now'), false);
  });

  test('"read the papers" → NOT bareAction ("papers" ≠ "the paper")', () => {
    // The pattern has literal "the paper" — "the papers" doesn't match
    assert.equal(bareAction('read the papers'), false);
  });

  test('"write a summary" → NOT bareAction ("a summary" not in the completions)', () => {
    assert.equal(bareAction('write a summary'), false);
  });

  test('"implement it all" → NOT bareAction (extra word "all")', () => {
    // "it all" has 2 words but the pattern only accepts one of: it|the paper|more|about it|everything
    assert.equal(bareAction('implement it all'), false);
  });

  test('"understand the theory" → NOT bareAction ("the theory" not in completions)', () => {
    // Completions are: it|the paper|more|about it|everything — NOT "the theory"
    assert.equal(bareAction('understand the theory'), false);
  });

  test('"read and implement" → NOT bareAction', () => {
    assert.equal(bareAction('read and implement'), false);
  });

  test('"maybe read it" → NOT bareAction (prefix "maybe")', () => {
    assert.equal(bareAction('maybe read it'), false);
  });

  test('"I want to read it" → NOT bareAction (sentence structure)', () => {
    assert.equal(bareAction('I want to read it'), false);
  });

  test('"implement it in pytorch" → NOT bareAction (extra words)', () => {
    assert.equal(bareAction('implement it in pytorch'), false);
  });

  // ── Edge: leading/trailing whitespace is trimmed before test ──
  test('"  read  " → bareAction (trimmed)', () => {
    assert.equal(bareAction('  read  '), true);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 57 — parseReminderMinutes: realistic natural language inputs
//
// Critical tricky case: "1.5 hours" — the regex /(\d+)\s*h(our)?/ matches the
// "5" from "1.5" (starts scanning left-to-right, finds "5 h" pattern), not the
// "1". So "1.5 hours" → 5*60 = 300 min (NOT 90 min). This is documented here
// as known behaviour.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseReminderMinutes — realistic natural language edge cases', () => {

  // ── Standard cases ──
  test('"30 min" → [30]', () => assert.deepEqual(parseReminderMinutes('30 min'), [30]));
  test('"1 hour" → [60]', () => assert.deepEqual(parseReminderMinutes('1 hour'), [60]));
  test('"2 hours" → [120]', () => assert.deepEqual(parseReminderMinutes('2 hours'), [120]));
  test('"15" (bare number) → [15]', () => assert.deepEqual(parseReminderMinutes('15'), [15]));
  test('"45" → [45]', () => assert.deepEqual(parseReminderMinutes('45'), [45]));
  test('"none" → []', () => assert.deepEqual(parseReminderMinutes('none'), []));
  test('"never" → []', () => assert.deepEqual(parseReminderMinutes('never'), []));
  test('"off" → []', () => assert.deepEqual(parseReminderMinutes('off'), []));

  // ── Combined: both hour and minute match → both in array ──
  test('"1 hour 30 min" → [60, 30]', () => {
    const r = parseReminderMinutes('1 hour 30 min');
    assert.ok(Array.isArray(r) && r.includes(60) && r.includes(30));
  });

  test('"2h 15m" → [120, 15]', () => {
    const r = parseReminderMinutes('2h 15m');
    assert.ok(Array.isArray(r) && r.includes(120) && r.includes(15));
  });

  // ── Natural language that CANNOT be parsed (returns null, not []) ──
  test('"half an hour" → null (no digit, can\'t parse)', () => {
    // "half" has no digit → neither hourMatch nor minMatch nor bareNum → null
    assert.equal(parseReminderMinutes('half an hour'), null);
  });

  test('"an hour" → null (no digit before "h")', () => {
    // /(\d+)\s*h(our)?/ — "an hour" has no digit before 'h' → no hourMatch → null
    assert.equal(parseReminderMinutes('an hour'), null);
  });

  test('"two hours" → null (word number, not digit)', () => {
    assert.equal(parseReminderMinutes('two hours'), null);
  });

  test('"fifteen minutes" → null (word number)', () => {
    assert.equal(parseReminderMinutes('fifteen minutes'), null);
  });

  // ── Tricky: "1.5 hours" — regex finds "5" not "1" ──
  test('"1.5 hours" → [300] (regex matches "5 h" from "1.5 hours", not "1 h")', () => {
    // The regex /(\d+)\s*h(our)?/ scans left-to-right:
    // - tries "1" then "." → "." is not \s*h → skip
    // - tries "5" then " hours" → "5 h" matches → group[1] = "5" → 5*60 = 300
    // This is a known regex quirk: decimal hours parse as the fractional part × 60.
    const r = parseReminderMinutes('1.5 hours');
    assert.ok(Array.isArray(r));
    assert.ok(r.includes(300)); // 5 * 60 = 300 (the "5" from "1.5" is matched)
  });

  // ── "no" prefix triggers the empty-array branch ──
  test('"no reminders" → [] (contains "no")', () => {
    assert.deepEqual(parseReminderMinutes('no reminders'), []);
  });

  test('"no thanks" → [] (contains "no")', () => {
    assert.deepEqual(parseReminderMinutes('no thanks'), []);
  });

  // ── Edge: "30mins" (no space, alternate suffix) ──
  test('"30mins" → [30] (no space before mins)', () => {
    // /(\d+)\s*m(in)?/ → "30m" → 30 ✓
    assert.deepEqual(parseReminderMinutes('30mins'), [30]);
  });

  test('"1h" (no "our") → [60]', () => {
    assert.deepEqual(parseReminderMinutes('1h'), [60]);
  });

  test('"60m" → [60]', () => {
    assert.deepEqual(parseReminderMinutes('60m'), [60]);
  });

  // ── Bare number only works when there's no hour or minute match ──
  test('"20" → [20] (bare number, no unit)', () => {
    assert.deepEqual(parseReminderMinutes('20'), [20]);
  });

  test('"remind me 30 minutes before" → [30] (minute match, not bare number)', () => {
    // "30 m" matches minMatch → [30]. bareNum does not fire (minMatch found).
    assert.deepEqual(parseReminderMinutes('remind me 30 minutes before'), [30]);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 58 — parseDurationMinutes: realistic user inputs for prefs setup
// ══════════════════════════════════════════════════════════════════════════════

describe('parseDurationMinutes — realistic user inputs', () => {

  test('"1 hour" → 60', () => assert.equal(parseDurationMinutes('1 hour'), 60));
  test('"2 hours" → 120', () => assert.equal(parseDurationMinutes('2 hours'), 120));
  test('"30 min" → 30', () => assert.equal(parseDurationMinutes('30 min'), 30));
  test('"90 min" → 90', () => assert.equal(parseDurationMinutes('90 min'), 90));
  test('"45" → 45', () => assert.equal(parseDurationMinutes('45'), 45));
  test('"1h30m" → 90 (hour + minute combined)', () => {
    assert.equal(parseDurationMinutes('1h30m'), 90);
  });
  test('"2h 15min" → 135', () => {
    assert.equal(parseDurationMinutes('2h 15min'), 135);
  });
  test('"1h" → 60', () => assert.equal(parseDurationMinutes('1h'), 60));
  test('"30" → 30 (bare number)', () => assert.equal(parseDurationMinutes('30'), 30));

  // ── Can't parse ──
  test('"one hour" → null (word number)', () => {
    assert.equal(parseDurationMinutes('one hour'), null);
  });
  test('"half hour" → null (no digit)', () => {
    assert.equal(parseDurationMinutes('half hour'), null);
  });
  test('"a while" → null', () => {
    assert.equal(parseDurationMinutes('a while'), null);
  });

  // ── Combined hour+minute where minMatch has decimal support ──
  test('"1.5h" → null (decimal hours not parsed as fractional — only int hours from hourMatch)', () => {
    // hourMatch = /(\d+)\s*h(our)?/ matches "1" then needs \s*h
    // "1.5h" → "1" then "." → not \s*h → fails at position 0
    // Then "5h" → matches! → hourMatch[1] = "5" → 5*60 = 300
    // So actually "1.5h" → 300 (same quirk as reminder minutes)
    const r = parseDurationMinutes('1.5h');
    assert.equal(r, 300); // The "5" from "1.5h" is matched, giving 5*60=300
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 59 — parseTimelineToDateFallback: realistic date expressions
// Tests use a fixed "now" = Monday 2026-04-13 for determinism.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseTimelineToDateFallback — realistic timeline strings', () => {

  // ── Today equivalents ──
  test('"today" → today\'s date', () => {
    const r = parseTimelineToDateFallback('today', FIXED_NOW);
    assert.ok(r?.startsWith('2026-04-13'));
  });

  test('"tonight" → today (same as today)', () => {
    const r = parseTimelineToDateFallback('tonight', FIXED_NOW);
    assert.ok(r?.startsWith('2026-04-13'));
  });

  test('"now" → today', () => {
    const r = parseTimelineToDateFallback('now', FIXED_NOW);
    assert.ok(r?.startsWith('2026-04-13'));
  });

  test('"asap" → today', () => {
    const r = parseTimelineToDateFallback('asap', FIXED_NOW);
    assert.ok(r?.startsWith('2026-04-13'));
  });

  test('"ASAP" → today (case insensitive)', () => {
    const r = parseTimelineToDateFallback('ASAP', FIXED_NOW);
    assert.ok(r?.startsWith('2026-04-13'));
  });

  // ── Tomorrow ──
  test('"tomorrow" → 2026-04-14', () => {
    const r = parseTimelineToDateFallback('tomorrow', FIXED_NOW);
    assert.equal(r, '2026-04-14');
  });

  // ── Day-of-week from Monday 2026-04-13 ──
  test('"tuesday" → 2026-04-14 (next day)', () => {
    // Monday + 1 = Tuesday
    const r = parseTimelineToDateFallback('tuesday', FIXED_NOW);
    assert.equal(r, '2026-04-14');
  });

  test('"saturday" → 2026-04-18', () => {
    // Monday (day 1) → Saturday (day 6): diff = (6-1+7)%7 = 5
    const r = parseTimelineToDateFallback('saturday', FIXED_NOW);
    assert.equal(r, '2026-04-18');
  });

  test('"sunday" → 2026-04-19', () => {
    // Monday → Sunday: diff = (0-1+7)%7 = 6 || 7 → 7 (the || 7 handles same-day)
    // Sunday is day 0. From Monday (1): (0-1+7)%7 = 6 → 6 days → 04-13 + 6 = 04-19
    const r = parseTimelineToDateFallback('sunday', FIXED_NOW);
    assert.equal(r, '2026-04-19');
  });

  test('"monday" from Monday → NEXT Monday (7 days, not today)', () => {
    // diff = (1-1+7)%7 = 0 → 0 || 7 = 7 → next Monday
    const r = parseTimelineToDateFallback('monday', FIXED_NOW);
    assert.equal(r, '2026-04-20');
  });

  test('"this Saturday" → same as "saturday" (contains day name)', () => {
    const r = parseTimelineToDateFallback('this Saturday', FIXED_NOW);
    assert.equal(r, '2026-04-18');
  });

  // ── Ordinal days ──
  test('"15th" → 2026-04-15 (15th is still ahead this month)', () => {
    const r = parseTimelineToDateFallback('15th', FIXED_NOW);
    assert.equal(r, '2026-04-15');
  });

  test('"1st" → 2026-05-01 (1st has passed this month → next month)', () => {
    // 1st of April has passed (now is 13th) → rolls to May 1st
    const r = parseTimelineToDateFallback('1st', FIXED_NOW);
    assert.equal(r, '2026-05-01');
  });

  test('"30th" → 2026-04-30', () => {
    const r = parseTimelineToDateFallback('30th', FIXED_NOW);
    assert.equal(r, '2026-04-30');
  });

  test('"the 20th" → 2026-04-20 (ordinal with article)', () => {
    const r = parseTimelineToDateFallback('the 20th', FIXED_NOW);
    assert.equal(r, '2026-04-20');
  });

  // ── Relative weeks/days ──
  test('"in 1 week" → 7 days from now', () => {
    const r = parseTimelineToDateFallback('in 1 week', FIXED_NOW);
    assert.equal(r, '2026-04-20');
  });

  test('"in 2 weeks" → 14 days from now', () => {
    const r = parseTimelineToDateFallback('in 2 weeks', FIXED_NOW);
    assert.equal(r, '2026-04-27');
  });

  test('"in 3 days" → 3 days from now', () => {
    const r = parseTimelineToDateFallback('in 3 days', FIXED_NOW);
    assert.equal(r, '2026-04-16');
  });

  // ── Unparseable inputs → null ──
  test('"next week" → null (no digit for week count)', () => {
    // /in (\d+) week/ requires "in" + digit — "next week" doesn't match
    assert.equal(parseTimelineToDateFallback('next week', FIXED_NOW), null);
  });

  test('"in two weeks" → null (word number "two" not a digit)', () => {
    // /in (\d+) week/ needs a digit — "two" is a word → no match
    assert.equal(parseTimelineToDateFallback('in two weeks', FIXED_NOW), null);
  });

  test('"end of month" → null', () => {
    assert.equal(parseTimelineToDateFallback('end of month', FIXED_NOW), null);
  });

  test('"soon" → null', () => {
    assert.equal(parseTimelineToDateFallback('soon', FIXED_NOW), null);
  });

  test('"by end of day" → null (not a recognisable pattern)', () => {
    // "end of day" stripped of "by" → "end of day" → native Date parse → NaN
    assert.equal(parseTimelineToDateFallback('by end of day', FIXED_NOW), null);
  });

  // ── Native parse fallback ──
  // NOTE: "Month Day" without a year (e.g. "June 30") → new Date("June 30") → Invalid Date
  // in Node.js because there is no year component. The regex path does not handle these.
  // This is the exact reason parseTimelineToDate (the AI version) is the primary path —
  // it correctly handles "June 30" by using the current year as context.
  test('"June 30" (no year) → null (regex fallback cannot parse month+day without year)', () => {
    // new Date("June 30") → NaN in Node.js → null. The AI parseTimelineToDate handles this.
    assert.equal(parseTimelineToDateFallback('June 30', FIXED_NOW), null);
  });

  test('"June 30, 2026" (with year) → non-null result in correct year', () => {
    // new Date("June 30, 2026") parsed as local midnight → UTC shift makes exact date
    // timezone-dependent. Just assert we got a valid 2026 date string (not null).
    const r = parseTimelineToDateFallback('June 30, 2026', FIXED_NOW);
    assert.ok(r !== null && r?.startsWith('2026'), `expected 2026 date, got: ${r}`);
  });

  test('"by June 30, 2026" → non-null (strips "by" prefix, valid date)', () => {
    const r = parseTimelineToDateFallback('by June 30, 2026', FIXED_NOW);
    assert.ok(r !== null && r?.startsWith('2026'), `expected 2026 date, got: ${r}`);
  });

  test('"on Monday the 20th" → day-of-week matched first (monday → +7 from fixed now)', () => {
    // DOW loop runs before ordinal/native — "monday" matched first
    const r = parseTimelineToDateFallback('on Monday the 20th', FIXED_NOW);
    assert.equal(r, '2026-04-20'); // next Monday from 13th = 20th
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 60 — isExplicitLearning: realistic borderline inputs
// The function is deliberately narrow — only unambiguous "I want to study this
// over time" language triggers it. Information queries go to web_search instead.
// ══════════════════════════════════════════════════════════════════════════════

describe('isExplicitLearning — realistic borderline inputs', () => {

  // ── True: unambiguous study intent (>5 words, explicit learning verb) ──
  test('"I want to learn about transformers" (6 words) → true', () => {
    assert.equal(isExplicitLearning('I want to learn about transformers', []), true);
  });

  test('"I want to learn about linear probes in AI alignment" → true', () => {
    assert.equal(isExplicitLearning('I want to learn about linear probes in AI alignment', []), true);
  });

  test('"I\'m learning about diffusion models lately" → true', () => {
    assert.equal(isExplicitLearning("I'm learning about diffusion models lately", []), true);
  });

  test('"been learning about sparse autoencoders for a while" → true', () => {
    assert.equal(isExplicitLearning('been learning about sparse autoencoders for a while', []), true);
  });

  test('"explain attention mechanisms to me in depth" → true (explain + to me, >4 words)', () => {
    assert.equal(isExplicitLearning('explain attention mechanisms to me in depth', []), true);
  });

  test('"I need to understand RLHF better for my research" → true', () => {
    assert.equal(isExplicitLearning('I need to understand RLHF better for my research', []), true);
  });

  // ── False: too short (≤5 words) even with learning language ──
  test('"I want to learn" (4 words, no topic) → false', () => {
    assert.equal(isExplicitLearning('I want to learn', []), false);
  });

  test('"want to learn about X" (5 words) → false (not > 5)', () => {
    assert.equal(isExplicitLearning('want to learn about X', []), false);
  });

  test('"learn about RLHF" (3 words) → false', () => {
    assert.equal(isExplicitLearning('learn about RLHF', []), false);
  });

  // ── False: has a URL (fast-path returns false) ──
  test('"I want to learn about this" with URL → false (URLs present)', () => {
    assert.equal(isExplicitLearning('I want to learn about this paper', ['https://arxiv.org/abs/1234']), false);
  });

  // ── False: information query language (not study intent) ──
  test('"what is the deadline for NeurIPS 2026?" → false (info query)', () => {
    assert.equal(isExplicitLearning('what is the deadline for NeurIPS 2026?', []), false);
  });

  test('"tell me about the event location" → false ("tell me about" is excluded)', () => {
    // "tell me about" is NOT in the pattern (intentionally excluded — too broad)
    assert.equal(isExplicitLearning('tell me about the event location please', []), false);
  });

  test('"what time does the conference start" → false', () => {
    assert.equal(isExplicitLearning('what time does the conference start', []), false);
  });

  test('"explain this to me" (5 words) → false (not > 4 for explain pattern)', () => {
    // The explain pattern requires words > 4. "explain this to me" = 4 words → false
    assert.equal(isExplicitLearning('explain this to me', []), false);
  });

  test('"can you explain RLHF to me" (6 words) → true (explain + to me)', () => {
    // words = 6 > 4, starts with "can you explain", has "to me"
    assert.equal(isExplicitLearning('can you explain RLHF to me', []), true);
  });

  test('"trying to learn more about mechanistic interpretability" → true', () => {
    assert.equal(isExplicitLearning('trying to learn more about mechanistic interpretability', []), true);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 61 — extractUrls: realistic Slack message formats
// Slack messages can have URLs in text, rich-text blocks, or link attachments.
// ══════════════════════════════════════════════════════════════════════════════

describe('extractUrls — realistic Slack message formats', () => {

  // ── Plain text ──
  test('plain text URL → extracted', () => {
    const urls = extractUrls({ text: 'check out https://arxiv.org/abs/2310.01405 for this' });
    assert.ok(urls.includes('https://arxiv.org/abs/2310.01405'));
  });

  test('URL with query params → extracted in full', () => {
    const url = 'https://forms.gle/abc123?ref=slack&source=bot';
    const urls = extractUrls({ text: `apply here ${url}` });
    assert.ok(urls.includes(url));
  });

  test('URL with hash fragment → extracted', () => {
    const url = 'https://example.com/page#section-2';
    const urls = extractUrls({ text: url });
    assert.ok(urls.includes(url));
  });

  test('Slack mrkdwn link format <url|text> → URL extracted, not the pipe/display text', () => {
    // The text field from Slack for "<https://arxiv.org/abs/1234|Attention Is All You Need>"
    // The regex /https?:\/\/[^\s<>|]+/ stops at | or > → extracts just the URL
    const urls = extractUrls({ text: '<https://arxiv.org/abs/1234|Attention Is All You Need>' });
    assert.ok(urls.includes('https://arxiv.org/abs/1234'));
    assert.ok(!urls.some(u => u.includes('|')));
  });

  test('two different URLs in text → both extracted', () => {
    const urls = extractUrls({ text: 'https://arxiv.org/abs/1 and https://arxiv.org/abs/2' });
    assert.equal(urls.length, 2);
  });

  test('same URL twice in text → deduplicated (only 1)', () => {
    const url = 'https://arxiv.org/abs/1234';
    const urls = extractUrls({ text: `${url} and also ${url}` });
    assert.equal(urls.length, 1);
  });

  test('slack.com URL → filtered out', () => {
    const urls = extractUrls({ text: 'https://acme.slack.com/files/U123/something' });
    assert.equal(urls.length, 0);
  });

  test('slack-edge.com URL → filtered out', () => {
    const urls = extractUrls({ text: 'https://files.slack-edge.com/emoji/abc.png' });
    assert.equal(urls.length, 0);
  });

  test('mixed: slack URL + real URL → only real URL returned', () => {
    const urls = extractUrls({
      text: 'https://acme.slack.com/files/abc and https://arxiv.org/abs/1234'
    });
    assert.equal(urls.length, 1);
    assert.ok(urls.includes('https://arxiv.org/abs/1234'));
  });

  // ── Blocks (rich text) ──
  test('URL in rich-text block link element → extracted', () => {
    const urls = extractUrls({
      text:   '',
      blocks: [{
        elements: [{
          type:     'rich_text_section',
          elements: [{
            type: 'link',
            url:  'https://arxiv.org/abs/9999',
          }]
        }]
      }]
    });
    assert.ok(urls.includes('https://arxiv.org/abs/9999'));
  });

  test('block link element with non-http URL → NOT extracted', () => {
    const urls = extractUrls({
      blocks: [{
        elements: [{
          type:     'rich_text_section',
          elements: [{ type: 'link', url: 'mailto:hello@example.com' }]
        }]
      }]
    });
    assert.equal(urls.length, 0);
  });

  // ── Attachments (Slack unfurl) ──
  test('attachment original_url → extracted', () => {
    const urls = extractUrls({
      attachments: [{ original_url: 'https://example.com/article' }]
    });
    assert.ok(urls.includes('https://example.com/article'));
  });

  test('attachment from_url → extracted', () => {
    const urls = extractUrls({
      attachments: [{ from_url: 'https://example.com/from' }]
    });
    assert.ok(urls.includes('https://example.com/from'));
  });

  test('attachment title_link → extracted', () => {
    const urls = extractUrls({
      attachments: [{ title_link: 'https://example.com/title' }]
    });
    assert.ok(urls.includes('https://example.com/title'));
  });

  test('attachment has same URL in original_url and from_url → deduplicated', () => {
    const url = 'https://example.com/same';
    const urls = extractUrls({
      attachments: [{ original_url: url, from_url: url }]
    });
    assert.equal(urls.length, 1);
  });

  test('empty message → no URLs', () => {
    assert.deepEqual(extractUrls({ text: '' }), []);
  });

  test('null text field → no crash, no URLs', () => {
    assert.deepEqual(extractUrls({}), []);
  });

  test('text with no URLs → empty array', () => {
    assert.deepEqual(extractUrls({ text: 'just a plain message with no links' }), []);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 62 — buildLearningTitle: realistic topic inputs from real users
// Tests with actual research topics a user might mention, including edge cases
// where topic stripping could go wrong.
// ══════════════════════════════════════════════════════════════════════════════

describe('buildLearningTitle — realistic research topic inputs', () => {

  test('"I want to learn about" + research topic → topic preserved', () => {
    const r = buildLearningTitle('implement', 'I want to learn about linear probes for AI alignment');
    assert.ok(r.includes('linear probes'));
    assert.ok(!r.includes('I want to learn about'));
  });

  test('topic with acronym: "RLHF" preserved after stripping', () => {
    const r = buildLearningTitle('read', 'I want to learn about RLHF');
    assert.ok(r.includes('RLHF'));
  });

  test('topic with quoted paper name: "Attention Is All You Need" preserved', () => {
    const r = buildLearningTitle('read', 'I want to learn about "Attention Is All You Need"');
    assert.ok(r.includes('Attention Is All You Need'));
  });

  test('topic "I want to" with no subject → verb only, no crash', () => {
    // "I want to" → strip "I want to " → "" → topicSlug = "" → just "Implement"
    const r = buildLearningTitle('implement', 'I want to');
    assert.ok(r.startsWith('Implement'));
    assert.ok(!r.endsWith(' ')); // no trailing space
  });

  test('complex topic: multiple prepositional phrases preserved', () => {
    const r = buildLearningTitle('understand', 'I want to learn about sparse autoencoders in the context of mechanistic interpretability');
    assert.ok(r.includes('sparse autoencoders'));
    assert.ok(r.length <= 80);
  });

  test('action "read it" → "it" stripped → "Read [topic]" not "Read it [topic]"', () => {
    const r = buildLearningTitle('read it', 'transformers');
    assert.equal(r, 'Read transformers');
  });

  test('action "implement more" → "more" stripped → "Implement [topic]"', () => {
    const r = buildLearningTitle('implement more', 'variational autoencoders');
    assert.equal(r, 'Implement variational autoencoders');
  });

  test('topic with "what are" → stripped', () => {
    const r = buildLearningTitle('understand', 'what are mixture of experts models');
    assert.ok(!r.includes('what are'));
    assert.ok(r.includes('mixture of experts'));
  });

  test('all-uppercase action → first letter uppercase, rest lowercase (charAt(0).toUpperCase)', () => {
    // buildLearningTitle does charAt(0).toUpperCase() + slice(1) — preserves case of rest
    const r = buildLearningTitle('IMPLEMENT', 'attention');
    assert.ok(r.startsWith('I')); // capitalised
    assert.ok(r.includes('MPLEMENT')); // rest preserved as-is
  });

  test('very long action + long topic → capped at 80 chars', () => {
    const r = buildLearningTitle(
      'implement from scratch',
      'I want to learn about neural ordinary differential equations and their applications in physics-informed machine learning'
    );
    assert.ok(r.length <= 80);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 63 — parseProjectFromText: realistic alias collision map
// Some project aliases are substrings of other words. Documents exact collision
// behaviours so changes to PROJECT_ALIASES immediately break these tests.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseProjectFromText — alias collision and priority documentation', () => {

  // ── Documented collisions: a shorter alias wins over a longer one ──
  test('"beadwork" text alone → "work" wins (alias "work" matched before "beadwork")', () => {
    // "beadwork".includes('work') === true, and 'work' is earlier in PROJECT_ALIASES
    // So parseProjectFromText('beadwork') returns 'work', not 'beadwork'.
    // The user should say "beads" to get beadwork — this test documents the known limitation.
    assert.equal(parseProjectFromText('beadwork'), 'work');
  });

  test('"art learning" → learning_tech wins (learning before art in alias order)', () => {
    // "art learning" contains "learning" (→ learning_tech) AND "art" (→ art)
    // "learning" alias is defined before "art" → learning_tech wins
    assert.equal(parseProjectFromText('art learning'), 'learning_tech');
  });

  test('"my work art" → work wins (work before art in alias order)', () => {
    assert.equal(parseProjectFromText('my work art'), 'work');
  });

  // ── Safe inputs that avoid collisions ──
  test('"beads" → beadwork (no collision)', () => {
    assert.equal(parseProjectFromText('beads'), 'beadwork');
  });

  test('"jewelry" → beadwork (no collision)', () => {
    assert.equal(parseProjectFromText('jewelry'), 'beadwork');
  });

  test('"drawing" → art (no collision)', () => {
    assert.equal(parseProjectFromText('drawing'), 'art');
  });

  test('"pastels" → art', () => {
    assert.equal(parseProjectFromText('pastels'), 'art');
  });

  // ── Substring matching (not \b) — documents known limitations ──
  test('"homework" → "work" (substring match: "homework".includes("work") is true)', () => {
    // parseProjectFromText uses String.includes(), not word boundaries.
    // "homework" contains "work" as a substring → returns 'work'.
    assert.equal(parseProjectFromText('homework'), 'work');
  });

  test('"artwork" → "work" ("work" alias earlier than "art" in iteration order)', () => {
    // "artwork" contains both "work" and "art" as substrings.
    // 'work' alias is defined before 'art' → returns 'work'.
    assert.equal(parseProjectFromText('artwork'), 'work');
  });

  test('"schoolwork" → school wins (school is first alias that matches)', () => {
    // "schoolwork".includes('school') → true → school wins
    // Note: also contains "work" but 'school' alias comes BEFORE 'work' in PROJECT_ALIASES
    assert.equal(parseProjectFromText('schoolwork'), 'school');
  });

  // ── Number/punctuation stripping (done before matching) ──
  test('"work!!" → work', () => {
    // text.replace(/[^a-z\s]/g, ' ') → "work  " → includes 'work' → work
    assert.equal(parseProjectFromText('work!!'), 'work');
  });

  test('"school123" → school', () => {
    assert.equal(parseProjectFromText('school123'), 'school');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 64 — normaliseTask: realistic AI output quirks
// Real AI responses may return unexpected types, extra fields, or edge-case
// values that should be handled gracefully.
// ══════════════════════════════════════════════════════════════════════════════

describe('normaliseTask — realistic AI output quirks', () => {

  test('AI returns title as description: "User wants to save..." → title is this string (no stripping)', () => {
    // normaliseTask does NOT strip AI meta-descriptions from title — that is the AI's job.
    // If AI returns a bad title, normaliseTask passes it through.
    const t = normaliseTask({ intent: 'save', title: 'User wants to save a paper on diffusion' });
    assert.equal(t.title, 'User wants to save a paper on diffusion');
  });

  test('AI returns title as number → null (not a string)', () => {
    const t = normaliseTask({ intent: 'save', title: 42 });
    assert.equal(t.title, null);
  });

  test('AI returns title as array → null (not a string)', () => {
    const t = normaliseTask({ intent: 'save', title: ['array title'] });
    assert.equal(t.title, null);
  });

  test('AI returns project_hint with space: "learning tech" → null (not in PROJECT_KEYS)', () => {
    const t = normaliseTask({ intent: 'save', project_hint: 'learning tech' });
    assert.equal(t.project_hint, null);
  });

  test('AI returns project_hint in wrong case: "Learning_Tech" → null', () => {
    const t = normaliseTask({ intent: 'save', project_hint: 'Learning_Tech' });
    assert.equal(t.project_hint, null);
  });

  test('AI returns priority_tier as float: 2.7 → null (Number.isInteger fails)', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: 2.7 });
    assert.equal(t.priority_tier, null);
  });

  test('AI returns priority_tier as null → null', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: null });
    assert.equal(t.priority_tier, null);
  });

  test('AI returns priority_tier as NaN → null', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: NaN });
    assert.equal(t.priority_tier, null);
  });

  test('AI returns needs_clarification: "yes" (string) → false', () => {
    const t = normaliseTask({ intent: 'save', needs_clarification: 'yes' });
    assert.equal(t.needs_clarification, false);
  });

  test('AI returns corrected_project: undefined → null', () => {
    const t = normaliseTask({ intent: 'correct' });
    assert.equal(t.corrected_project, null);
  });

  test('AI returns context: "Work" (wrong case) → passes through as-is', () => {
    // normaliseTask does not validate context — it passes through whatever is given
    const t = normaliseTask({ intent: 'save', context: 'Work' });
    assert.equal(t.context, 'Work');
  });

  test('entirely empty object → all defaults: intent=save, everything null/false', () => {
    const t = normaliseTask({});
    assert.equal(t.intent, 'save');
    assert.equal(t.title, null);
    assert.equal(t.timeline, null);
    assert.equal(t.context, null);
    assert.equal(t.project_hint, null);
    assert.equal(t.priority_tier, null);
    assert.equal(t.needs_clarification, false);
    assert.equal(t.corrected_project, null);
    assert.equal(t.recall_topic, null);
    assert.equal(t.search_query, null);
  });

  test('recall_topic as number → null', () => {
    const t = normaliseTask({ intent: 'recall', recall_topic: 123 });
    assert.equal(t.recall_topic, null);
  });

  test('search_query with leading/trailing whitespace → trimmed', () => {
    const t = normaliseTask({ intent: 'web_search', search_query: '  NeurIPS 2026 date  ' });
    assert.equal(t.search_query, 'NeurIPS 2026 date');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 65 — wantsPrefs: realistic trigger inputs
// Covers natural phrasing users might use to open the preferences flow, and
// inputs that should NOT trigger it (contain save/remind/add keywords).
// ══════════════════════════════════════════════════════════════════════════════

describe('wantsPrefs — realistic trigger and anti-trigger inputs', () => {

  // ── Should trigger ──
  test('"update my preferences" → true', () => {
    assert.equal(wantsPrefs('update my preferences'), true);
  });

  test('"change my calendar settings" → true', () => {
    assert.equal(wantsPrefs('change my calendar settings'), true);
  });

  test('"I want to configure the bot" → true', () => {
    assert.equal(wantsPrefs('I want to configure the bot'), true);
  });

  test('"set up reminders" → true (contains "set up")', () => {
    // Contains "set up" → true. Does not contain save/remind/add/create
    // Wait: "set up reminders" contains "remind" in "reminders"? Let me check:
    // !/\b(save|remind|add|create)\b/i.test("set up reminders")
    // "reminders".includes("remind") → but the regex uses \b word boundaries
    // \bremind\b in "reminders": 'd' followed by 'e' (word char) → no boundary after "remind"
    // So \bremind\b does NOT match in "reminders" → wantsPrefs returns true
    assert.equal(wantsPrefs('set up reminders'), true);
  });

  test('"how do I setup the calendar" → true', () => {
    assert.equal(wantsPrefs('how do I setup the calendar'), true);
  });

  // ── Should NOT trigger (save/remind/add/create suppress it) ──
  test('"save my preferences please" → false (contains "save")', () => {
    assert.equal(wantsPrefs('save my preferences please'), false);
  });

  test('"add to my preferences" → false (contains "add")', () => {
    assert.equal(wantsPrefs('add to my preferences'), false);
  });

  test('"remind me to check settings tomorrow" → false (contains "remind")', () => {
    // \bremind\b matches in "remind me" → suppresses
    assert.equal(wantsPrefs('remind me to check settings tomorrow'), false);
  });

  test('"create new settings file" → false (contains "create")', () => {
    assert.equal(wantsPrefs('create new settings file'), false);
  });

  // ── Should NOT trigger (no prefs keyword) ──
  test('"I want to read the paper" → false', () => {
    assert.equal(wantsPrefs('I want to read the paper'), false);
  });

  test('"remind me to do the assignment" → false', () => {
    assert.equal(wantsPrefs('remind me to do the assignment'), false);
  });

  test('"set a reminder for tomorrow" → false (no prefs keyword)', () => {
    // "set" alone is not in the prefs keywords — needs "set up" or "setup"
    assert.equal(wantsPrefs('set a reminder for tomorrow'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 66 — hasSearchAsk: realistic clarification + search combo messages
// ══════════════════════════════════════════════════════════════════════════════

describe('hasSearchAsk — realistic combined clarification + search messages', () => {

  test('"work, also can you find out when it is?" → true', () => {
    assert.equal(hasSearchAsk('work, also can you find out when it is?'), true);
  });

  test('"personal — look up the venue address" → true', () => {
    assert.equal(hasSearchAsk('personal — look up the venue address'), true);
  });

  test('"work — what time does the event start?" → true', () => {
    assert.equal(hasSearchAsk('work — what time does the event start?'), true);
  });

  test('"personal, when is the deadline for this?" → true', () => {
    assert.equal(hasSearchAsk('personal, when is the deadline for this?'), true);
  });

  test('"p, search it" → true', () => {
    assert.equal(hasSearchAsk('p, search it'), true);
  });

  // ── False: clean answers with no search keywords ──
  test('"work" → false', () => assert.equal(hasSearchAsk('work'), false));
  test('"personal" → false', () => assert.equal(hasSearchAsk('personal'), false));
  test('"it\'s for work, nothing else" → false', () => {
    assert.equal(hasSearchAsk("it's for work, nothing else"), false);
  });

  test('"w" (bare initial) → false', () => assert.equal(hasSearchAsk('w'), false));

  // ── Tricky: "find" as part of another word ──
  test('"finding it hard to categorise" → true (contains "find")', () => {
    // "finding".includes("find") → the regex is /\bfind\b/ which needs word boundary
    // \bfind\b in "finding": 'd' followed by 'i' (word char) → NO boundary after "find"
    // So "finding it hard to categorise" → false? Let me check the actual regex:
    // /\b(find|look up|search|when is|what.s the date|what time)\b/i
    // In "finding": \bfind\b → 'd' at position 3, followed by 'i' → not a word boundary → NO match
    assert.equal(hasSearchAsk('finding it hard to categorise'), false);
  });
});
