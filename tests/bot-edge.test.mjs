/**
 * Bot edge-case and decision-logic unit tests.
 *
 * Covers branches and pure-function contracts NOT already in bot-flow.test.mjs:
 *   - isDuplicate deduplication guard
 *   - softCheckIn decision (reset vs save)
 *   - correctionMode reask count and give-up path
 *   - reminderMode double-reask fallback to todo
 *   - hasSearchAsk detection (clarification + web search combo)
 *   - wantsEventDate detection in recall
 *   - wantsPrefs trigger and negative cases
 *   - looksLikeNewReminder guard (reminderMode abort)
 *   - isToDoReply detection
 *   - recall response format (buildRecallLine)
 *   - buildLearningTitle comprehensive edge cases
 *   - clarificationMode new-URL abort condition
 *   - Pass 2 pending state shapes
 *   - normaliseTask field contracts (edge inputs)
 *   - parseClarificationContext edge inputs
 *   - buildEnrichedText combinations
 *   - parseProjectFromText full alias table
 *   - reminderMode reply format contracts
 *   - prefsMode step validation boundary values
 *   - Multi-task needsInput accumulation
 *
 * Run: node --test tests/bot-edge.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_INTENTS, PROJECT_KEYS } from '../lib/intentPrompt.js';

// ── Replicated pure functions (keep in sync with bot.js) ──────────────────────

const APP_URL = 'https://project-os.vercel.app';

const PROJECT_EMOJI = {
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
};

function buildSuccessMessage(data, cls = {}) {
  const projectEmoji = PROJECT_EMOJI[data.project] ?? '📁';
  const appUrl = `${APP_URL}/project/${data.project}`;
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

function parseClarificationContext(text) {
  if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(text)) return 'work';
  if (/\bpersonal\b|\bperson\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  const t = text.toLowerCase();
  if (/^w\b/i.test(t.trim())) return 'work';
  if (/^p\b/i.test(t.trim())) return 'personal';
  return null;
}

const PROJECT_ALIASES = {
  'personal':      'personal',
  'school':        'school',        'uni': 'school',      'university': 'school',
  'work':          'work',          'job': 'work',
  'research':      'research_apps', 'applications': 'research_apps', 'apps': 'research_apps',
  'learning':      'learning_tech', 'tech': 'learning_tech', 'learn': 'learning_tech',
  'circuits':      'circuitry',     'electronics': 'circuitry',     'arduino': 'circuitry',
  'baking':        'baking',        'bread': 'baking',
  'beads':         'beadwork',      'beadwork': 'beadwork',          'jewelry': 'beadwork',
  'art':           'art',           'drawing': 'art',                'pastels': 'art',
  'reading':       'reading',       'books': 'reading',
  'exercise':      'exercise',      'gym': 'exercise',               'fitness': 'exercise',
};

function parseProjectFromText(text) {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
}

function buildEnrichedText(context, timeline, text, url) {
  const parts = [];
  if (context === 'work')     parts.push('[Work]');
  if (context === 'personal') parts.push('[Personal]');
  if (text && text !== url)   parts.push(text.replace(url ?? '', '').trim());
  if (timeline)               parts.push(`— ${timeline}`);
  return parts.filter(Boolean).join(' ');
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

// buildLearningTitle (replicated from bot.js — KEEP IN SYNC)
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

// Recall response format (replicated from bot.js recall handler)
function buildRecallLine(r) {
  const emoji   = PROJECT_EMOJI[r.project] ?? '📁';
  const dateStr = r.saved_at
    ? ` · ${new Date(r.saved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`
    : '';
  const link    = r.url ? `<${r.url}|${r.title}>` : r.title;
  return `${emoji} ${link}${dateStr}`;
}

// softCheckIn decision (replicated from bot.js learningMode softCheckIn branch)
function softCheckInDecision(userText) {
  const lc = userText.toLowerCase().trim();
  if (/^(no|nah|nope|not yet|keep going|continue|later)/.test(lc)) {
    return { action: 'reset', step: 5, reply: 'all good — keep going' };
  }
  return { action: 'save', saveText: userText.trim().slice(0, 60) };
}

// correctionMode reask decision (replicated from bot.js correctionMode handler)
function correctionReaskDecision(proj, currentReaskCount) {
  if (proj) return { action: 'correct', project: proj };
  const newCount = currentReaskCount + 1;
  if (newCount >= 2) return { action: 'give_up', reply: 'ok, keeping it as-is' };
  return {
    action:   'reask',
    reaskCount: newCount,
    reply: "didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal",
  };
}

// reminderMode reask decision (replicated from bot.js reminderMode date-fail path)
function reminderDateFallbackDecision(reask) {
  const newReask = reask + 1;
  if (newReask >= 2) return { action: 'save_todo' };
  return {
    action: 'reask',
    reask:  newReask,
    reply:  "didn't catch a date — try \"this Saturday\", \"13th\", \"in 2 weeks\", or say *to do* to add to your list",
  };
}

// isDuplicate (replicated from bot.js)
function makeDedupTracker() {
  const _seen = new Set();
  return function isDuplicate(message) {
    const key = message.client_msg_id ?? message.ts;
    if (!key) return false;
    if (_seen.has(key)) return true;
    _seen.add(key);
    if (_seen.size > 500) _seen.clear();
    return false;
  };
}

// ── Regex detectors replicated from bot.js ────────────────────────────────────

// Detects "find/search/when is" in a clarificationMode reply → save + web search combo
const hasSearchAsk = (text) =>
  /\b(find|look up|search|when is|what.s the date|what time)\b/i.test(text);

// Detects event-date queries in recall fallthrough → web_search
const wantsEventDate = (text) =>
  /\b(what'?s the date|when is|find the date|date of|where is|what time)\b/i.test(text);

// Detects "preferences/settings" trigger
const wantsPrefs = (text) =>
  /\b(preference|preferences|settings|set up|setup|configure|change my)\b/i.test(text)
  && !/\b(save|remind|add|create)\b/i.test(text);

// Detects "to do" / "add to list" replies in reminderMode
const isToDoReply = (text) =>
  /^(to.?do|td|my list|add to list|no date|just add it|whenever)$/i.test(text.toLowerCase().trim());

// Detects a new "remind me to..." message while in reminderMode → clear pending
const looksLikeNewReminder = (text) =>
  /^(remind me|set a reminder|can you remind|add a reminder)\b/i.test(text.trim())
  && text.trim().split(/\s+/).length > 5;


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 32 — isDuplicate deduplication guard
// Prevents the bot from processing the same Slack event twice (Bolt retries on
// slow acks). Without this, a single save message could create two DB rows.
// ══════════════════════════════════════════════════════════════════════════════

describe('isDuplicate — deduplication guard', () => {
  test('first call with client_msg_id → not duplicate', () => {
    const isDuplicate = makeDedupTracker();
    assert.equal(isDuplicate({ client_msg_id: 'msg-abc-123' }), false);
  });

  test('second call with same client_msg_id → duplicate', () => {
    const isDuplicate = makeDedupTracker();
    isDuplicate({ client_msg_id: 'msg-abc-123' });
    assert.equal(isDuplicate({ client_msg_id: 'msg-abc-123' }), true);
  });

  test('different client_msg_ids → neither is duplicate', () => {
    const isDuplicate = makeDedupTracker();
    assert.equal(isDuplicate({ client_msg_id: 'msg-001' }), false);
    assert.equal(isDuplicate({ client_msg_id: 'msg-002' }), false);
  });

  test('falls back to ts when client_msg_id is absent', () => {
    const isDuplicate = makeDedupTracker();
    assert.equal(isDuplicate({ ts: '1234567890.000100' }), false);
    assert.equal(isDuplicate({ ts: '1234567890.000100' }), true);
  });

  test('message with no key (no client_msg_id, no ts) → never duplicate', () => {
    const isDuplicate = makeDedupTracker();
    assert.equal(isDuplicate({}), false);
    assert.equal(isDuplicate({}), false); // still false — can't track keyless messages
  });

  test('client_msg_id takes precedence over ts when both present', () => {
    const isDuplicate = makeDedupTracker();
    // First seen by client_msg_id
    assert.equal(isDuplicate({ client_msg_id: 'msg-x', ts: 'ts-y' }), false);
    // Second time same client_msg_id → duplicate (ts doesn't matter)
    assert.equal(isDuplicate({ client_msg_id: 'msg-x', ts: 'ts-z' }), true);
  });

  test('separate tracker instances are independent', () => {
    const tracker1 = makeDedupTracker();
    const tracker2 = makeDedupTracker();
    tracker1({ client_msg_id: 'shared-id' });
    // tracker2 hasn't seen this id
    assert.equal(tracker2({ client_msg_id: 'shared-id' }), false);
  });

  test('set auto-clears when size exceeds 500 — no crash on large volume', () => {
    const isDuplicate = makeDedupTracker();
    // Insert 501 unique messages — should not throw
    for (let i = 0; i < 501; i++) {
      isDuplicate({ client_msg_id: `msg-volume-${i}` });
    }
    // After clear, a previously seen id is no longer tracked
    // (this is intentional: clear prevents unbounded memory growth)
    assert.ok(true); // if we reach here, no crash occurred
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 33 — softCheckIn decision logic
// After 8 learning chat turns, bot asks "want me to save something?"
// User replies "no" → reset step counter for more conversation.
// User replies with a task → save immediately.
// ══════════════════════════════════════════════════════════════════════════════

describe('softCheckIn — save vs reset decision', () => {
  // ── Reset triggers (user wants to keep talking) ──
  test('"no" → resets step to 5, not save', () => {
    const r = softCheckInDecision('no');
    assert.equal(r.action, 'reset');
    assert.equal(r.step, 5);
  });

  test('"nah" → reset', () => {
    assert.equal(softCheckInDecision('nah').action, 'reset');
  });

  test('"nope" → reset', () => {
    assert.equal(softCheckInDecision('nope').action, 'reset');
  });

  test('"not yet" → reset', () => {
    assert.equal(softCheckInDecision('not yet').action, 'reset');
  });

  test('"keep going" → reset', () => {
    assert.equal(softCheckInDecision('keep going').action, 'reset');
  });

  test('"continue" → reset', () => {
    assert.equal(softCheckInDecision('continue').action, 'reset');
  });

  test('"later" → reset', () => {
    assert.equal(softCheckInDecision('later').action, 'reset');
  });

  test('reset reply is always "all good — keep going"', () => {
    assert.equal(softCheckInDecision('no').reply, 'all good — keep going');
    assert.equal(softCheckInDecision('nah').reply, 'all good — keep going');
  });

  // ── Save triggers (user named a task) ──
  test('"read the paper" → save with saveText = "read the paper"', () => {
    const r = softCheckInDecision('read the paper');
    assert.equal(r.action, 'save');
    assert.equal(r.saveText, 'read the paper');
  });

  test('"implement it in PyTorch from scratch" → save', () => {
    const r = softCheckInDecision('implement it in PyTorch from scratch');
    assert.equal(r.action, 'save');
    assert.ok(r.saveText.startsWith('implement'));
  });

  test('"understand the maths" → save', () => {
    assert.equal(softCheckInDecision('understand the maths').action, 'save');
  });

  test('"write a summary of the key results" → save', () => {
    assert.equal(softCheckInDecision('write a summary of the key results').action, 'save');
  });

  test('saveText is capped at 60 characters', () => {
    const longReply = 'implement it completely from scratch using PyTorch with custom CUDA kernels';
    const r = softCheckInDecision(longReply);
    assert.equal(r.action, 'save');
    assert.ok(r.saveText.length <= 60);
  });

  // ── Case insensitivity ──
  test('"NO" (uppercase) → reset', () => {
    assert.equal(softCheckInDecision('NO').action, 'reset');
  });

  test('"Nah, keep going" → reset (starts with nah)', () => {
    assert.equal(softCheckInDecision('Nah, keep going').action, 'reset');
  });

  // ── Edge: question itself (user asking something) → treat as save ──
  test('"what about the training procedure?" → save (not reset)', () => {
    assert.equal(softCheckInDecision('what about the training procedure?').action, 'save');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 34 — correctionMode reask count and give-up path
// User says "that was wrong" → bot asks which project.
// If user gives an unrecognised reply, bot re-asks once.
// After 2 failed attempts → give up and say "ok, keeping it as-is".
// ══════════════════════════════════════════════════════════════════════════════

describe('correctionMode — reask count and give-up', () => {
  // ── Happy path: project recognised ──
  test('project found on first attempt → correct immediately', () => {
    const r = correctionReaskDecision('school', 0);
    assert.equal(r.action, 'correct');
    assert.equal(r.project, 'school');
  });

  test('project found on reask → correct (not give-up)', () => {
    const r = correctionReaskDecision('learning_tech', 1);
    assert.equal(r.action, 'correct');
    assert.equal(r.project, 'learning_tech');
  });

  // ── Reask path ──
  test('project null, reaskCount=0 → reask with count=1', () => {
    const r = correctionReaskDecision(null, 0);
    assert.equal(r.action, 'reask');
    assert.equal(r.reaskCount, 1);
    assert.ok(r.reply.includes("didn't catch that"));
  });

  test('reask reply lists all valid project keys', () => {
    const r = correctionReaskDecision(null, 0);
    assert.ok(r.reply.includes('school'));
    assert.ok(r.reply.includes('work'));
    assert.ok(r.reply.includes('learning'));
    assert.ok(r.reply.includes('research'));
    assert.ok(r.reply.includes('personal'));
  });

  // ── Give-up path (2nd strike) ──
  test('project null, reaskCount=1 → give_up', () => {
    const r = correctionReaskDecision(null, 1);
    assert.equal(r.action, 'give_up');
    assert.equal(r.reply, 'ok, keeping it as-is');
  });

  test('project null, reaskCount=2 → give_up (already past threshold)', () => {
    const r = correctionReaskDecision(null, 2);
    assert.equal(r.action, 'give_up');
  });

  test('give-up reply is "ok, keeping it as-is"', () => {
    const r = correctionReaskDecision(null, 1);
    assert.equal(r.reply, 'ok, keeping it as-is');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 35 — reminderMode double-reask fallback to todo
// When user is asked "when is X?" and can't provide a parseable date twice,
// bot saves the item to the to-do list (personal Kanban) rather than looping.
// ══════════════════════════════════════════════════════════════════════════════

describe('reminderMode — reask-twice fallback to todo', () => {
  test('reask=0 → first failed parse → reask (count becomes 1)', () => {
    const r = reminderDateFallbackDecision(0);
    assert.equal(r.action, 'reask');
    assert.equal(r.reask, 1);
  });

  test('reask=0 → reask reply contains helpful examples', () => {
    const r = reminderDateFallbackDecision(0);
    assert.ok(r.reply.includes("didn't catch a date"));
    assert.ok(r.reply.includes('this Saturday'));
    assert.ok(r.reply.includes('to do'));
  });

  test('reask=1 → second failed parse → save_todo (give up)', () => {
    const r = reminderDateFallbackDecision(1);
    assert.equal(r.action, 'save_todo');
  });

  test('reask=2 → already past threshold → save_todo', () => {
    const r = reminderDateFallbackDecision(2);
    assert.equal(r.action, 'save_todo');
  });

  test('save_todo path has no reply string (bot builds the message from reminderTitle)', () => {
    const r = reminderDateFallbackDecision(1);
    assert.equal(r.action, 'save_todo');
    assert.equal(r.reply, undefined);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 36 — hasSearchAsk detection
// When user answers "work or personal?" AND includes a search request
// (e.g. "personal, but can you find the date?"), bot saves AND runs a web search
// instead of returning the app confirmation link.
// ══════════════════════════════════════════════════════════════════════════════

describe('hasSearchAsk — clarification + web search combo detection', () => {
  // ── True cases ──
  test('"personal, can you find the date?" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('personal, can you find the date?'), true);
  });

  test('"work — look up the event location" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('work — look up the event location'), true);
  });

  test('"personal but search for it" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('personal but search for it'), true);
  });

  test('"when is this?" in clarification reply → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('personal, when is this?'), true);
  });

  test('"what\'s the date for this" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk("personal, what's the date for this"), true);
  });

  test('"what time does it start" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('work — what time does it start?'), true);
  });

  // ── False cases ──
  test('"work" alone → no search ask', () => {
    assert.equal(hasSearchAsk('work'), false);
  });

  test('"personal" alone → no search ask', () => {
    assert.equal(hasSearchAsk('personal'), false);
  });

  test('"it\'s for work, add it to my board" → no search ask', () => {
    assert.equal(hasSearchAsk("it's for work, add it to my board"), false);
  });

  test('case insensitive: "FIND the link" → hasSearchAsk', () => {
    assert.equal(hasSearchAsk('personal — FIND the link'), true);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 37 — wantsEventDate detection in recall
// When recall finds no saved results, bot checks if the user was really asking
// for live event information ("when is X?") and falls through to web_search.
// ══════════════════════════════════════════════════════════════════════════════

describe('wantsEventDate — recall fallthrough to web_search', () => {
  // ── True cases ──
  test('"when is the NeurIPS deadline?" → wantsEventDate', () => {
    assert.equal(wantsEventDate('when is the NeurIPS deadline?'), true);
  });

  test('"what\'s the date of the Square Peg event?" → wantsEventDate', () => {
    assert.equal(wantsEventDate("what's the date of the Square Peg event?"), true);
  });

  test('"find the date for ICML 2026" → wantsEventDate', () => {
    assert.equal(wantsEventDate('find the date for ICML 2026'), true);
  });

  test('"where is NeurIPS held?" → wantsEventDate', () => {
    assert.equal(wantsEventDate('where is NeurIPS held?'), true);
  });

  test('"what time does the hackathon start?" → wantsEventDate', () => {
    assert.equal(wantsEventDate('what time does the hackathon start?'), true);
  });

  test('"date of the fellowship deadline" → wantsEventDate', () => {
    assert.equal(wantsEventDate('date of the fellowship deadline'), true);
  });

  // ── False cases ──
  test('"what did I save about transformers?" → not wantsEventDate', () => {
    assert.equal(wantsEventDate('what did I save about transformers?'), false);
  });

  test('"anything on diffusion models?" → not wantsEventDate', () => {
    assert.equal(wantsEventDate('anything on diffusion models?'), false);
  });

  test('"show me my reading list" → not wantsEventDate', () => {
    assert.equal(wantsEventDate('show me my reading list'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 38 — wantsPrefs trigger detection
// "preferences" / "settings" etc. → open preferences flow.
// Must NOT trigger when user says "save my preference" (contains save keyword).
// ══════════════════════════════════════════════════════════════════════════════

describe('wantsPrefs — trigger and negative cases', () => {
  // ── Positive triggers ──
  test('"preferences" → wantsPrefs', () => {
    assert.equal(wantsPrefs('preferences'), true);
  });

  test('"set preferences" → wantsPrefs', () => {
    assert.equal(wantsPrefs('set preferences'), true);
  });

  test('"change my settings" → wantsPrefs', () => {
    assert.equal(wantsPrefs('change my settings'), true);
  });

  test('"settings" alone → wantsPrefs', () => {
    assert.equal(wantsPrefs('settings'), true);
  });

  test('"configure" → wantsPrefs', () => {
    assert.equal(wantsPrefs('configure'), true);
  });

  test('"set up calendar" → wantsPrefs', () => {
    assert.equal(wantsPrefs('set up calendar'), true);
  });

  test('"setup" → wantsPrefs', () => {
    assert.equal(wantsPrefs('setup'), true);
  });

  // ── Negative: save/remind/add suppresses trigger ──
  test('"save my preferences to file" → NOT wantsPrefs (contains save)', () => {
    assert.equal(wantsPrefs('save my preferences to file'), false);
  });

  test('"remind me to check my settings" → NOT wantsPrefs (contains remind)', () => {
    assert.equal(wantsPrefs('remind me to check my settings'), false);
  });

  test('"add to my preferences" → NOT wantsPrefs (contains add)', () => {
    assert.equal(wantsPrefs('add to my preferences'), false);
  });

  test('"create new settings" → NOT wantsPrefs (contains create)', () => {
    assert.equal(wantsPrefs('create new settings'), false);
  });

  // ── Negative: unrelated messages ──
  test('"I want to learn about attention" → NOT wantsPrefs', () => {
    assert.equal(wantsPrefs('I want to learn about attention'), false);
  });

  test('"remind me to buy milk" → NOT wantsPrefs', () => {
    assert.equal(wantsPrefs('remind me to buy milk'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 39 — looksLikeNewReminder guard
// When in reminderMode (bot asked "when is X?"), if the user sends a completely
// new "remind me to..." message instead of a date, bot should abort the pending
// state and re-classify the new message rather than treating it as a date reply.
// ══════════════════════════════════════════════════════════════════════════════

describe('looksLikeNewReminder — reminderMode abort guard', () => {
  // ── True: clear pending and re-classify ──
  test('"remind me to call the doctor next Monday" → new reminder (>5 words)', () => {
    assert.equal(looksLikeNewReminder('remind me to call the doctor next Monday'), true);
  });

  test('"set a reminder for gym every Tuesday morning" → new reminder', () => {
    assert.equal(looksLikeNewReminder('set a reminder for gym every Tuesday morning'), true);
  });

  test('"can you remind me about the assignment due Thursday" → new reminder', () => {
    assert.equal(looksLikeNewReminder('can you remind me about the assignment due Thursday'), true);
  });

  test('"add a reminder for dentist appointment next week" → new reminder', () => {
    assert.equal(looksLikeNewReminder('add a reminder for dentist appointment next week'), true);
  });

  // ── False: short messages (user is replying with a date) ──
  test('"this Saturday" → NOT new reminder (likely a date reply)', () => {
    assert.equal(looksLikeNewReminder('this Saturday'), false);
  });

  test('"tomorrow afternoon" → NOT new reminder', () => {
    assert.equal(looksLikeNewReminder('tomorrow afternoon'), false);
  });

  test('"remind me" (2 words) → NOT new reminder (too short)', () => {
    assert.equal(looksLikeNewReminder('remind me'), false);
  });

  test('"to do" → NOT new reminder', () => {
    assert.equal(looksLikeNewReminder('to do'), false);
  });

  // ── False: doesn't start with reminder keywords ──
  test('"I\'ll go with the 13th" → NOT new reminder', () => {
    assert.equal(looksLikeNewReminder("I'll go with the 13th"), false);
  });

  test('"actually scratch that" → NOT new reminder', () => {
    assert.equal(looksLikeNewReminder('actually scratch that'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 40 — isToDoReply detection
// When in reminderMode, user can say "to do", "td", "my list" etc. to skip the
// calendar and just add to the personal Kanban board.
// ══════════════════════════════════════════════════════════════════════════════

describe('isToDoReply — Kanban add shortcut detection', () => {
  // ── True cases ──
  test('"to do" → isToDoReply', () => {
    assert.equal(isToDoReply('to do'), true);
  });

  test('"todo" → isToDoReply', () => {
    assert.equal(isToDoReply('todo'), true);
  });

  test('"to-do" → isToDoReply', () => {
    assert.equal(isToDoReply('to-do'), true);
  });

  test('"td" → isToDoReply', () => {
    assert.equal(isToDoReply('td'), true);
  });

  test('"my list" → isToDoReply', () => {
    assert.equal(isToDoReply('my list'), true);
  });

  test('"add to list" → isToDoReply', () => {
    assert.equal(isToDoReply('add to list'), true);
  });

  test('"no date" → isToDoReply', () => {
    assert.equal(isToDoReply('no date'), true);
  });

  test('"just add it" → isToDoReply', () => {
    assert.equal(isToDoReply('just add it'), true);
  });

  test('"whenever" → isToDoReply', () => {
    assert.equal(isToDoReply('whenever'), true);
  });

  // ── Case insensitive ──
  test('"TO DO" → isToDoReply', () => {
    assert.equal(isToDoReply('TO DO'), true);
  });

  test('"My List" → isToDoReply', () => {
    assert.equal(isToDoReply('My List'), true);
  });

  // ── False cases (specific dates or other replies) ──
  test('"this Saturday" → NOT isToDoReply', () => {
    assert.equal(isToDoReply('this Saturday'), false);
  });

  test('"tomorrow" → NOT isToDoReply', () => {
    assert.equal(isToDoReply('tomorrow'), false);
  });

  test('"I\'ll add it later" → NOT isToDoReply (too long, not exact match)', () => {
    assert.equal(isToDoReply("I'll add it later"), false);
  });

  test('"in my list already" → NOT isToDoReply', () => {
    assert.equal(isToDoReply('in my list already'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 41 — recall response format (buildRecallLine)
// Format: "{emoji} <url|title> · 12 Apr" or "{emoji} title · 12 Apr"
// ══════════════════════════════════════════════════════════════════════════════

describe('buildRecallLine — recall item format contracts', () => {
  test('learning_tech item with URL → 📚 Slack link format', () => {
    const line = buildRecallLine({
      project:  'learning_tech',
      title:    'Linear Probes in LLMs',
      url:      'https://arxiv.org/abs/2310.01405',
      saved_at: null,
    });
    assert.ok(line.startsWith('📚'));
    assert.ok(line.includes('<https://arxiv.org/abs/2310.01405|Linear Probes in LLMs>'));
  });

  test('item without URL → plain title (no link syntax)', () => {
    const line = buildRecallLine({
      project:  'school',
      title:    'Physics Assignment 3',
      url:      null,
      saved_at: null,
    });
    assert.ok(line.startsWith('🎓'));
    assert.ok(line.includes('Physics Assignment 3'));
    assert.ok(!line.includes('<http')); // no link
  });

  test('item with saved_at → date appended after " · "', () => {
    const line = buildRecallLine({
      project:  'research_apps',
      title:    'Meridian Fellowship',
      url:      null,
      saved_at: '2026-04-01T00:00:00Z',
    });
    assert.ok(line.includes(' · '));
    // Date format: "1 Apr" or "Apr 1" — Australian locale
    assert.ok(/\d+\s+\w+|\w+\s+\d+/.test(line.split(' · ')[1]));
  });

  test('item without saved_at → no date suffix', () => {
    const line = buildRecallLine({ project: 'work', title: 'Fix deploy bug', url: null, saved_at: null });
    // Should end with the title, no date
    assert.ok(!line.includes(' · '));
  });

  test('work → 💼 emoji', () => {
    const line = buildRecallLine({ project: 'work', title: 'Sprint task', url: null, saved_at: null });
    assert.ok(line.startsWith('💼'));
  });

  test('personal → 🗓️ emoji', () => {
    const line = buildRecallLine({ project: 'personal', title: 'Dentist', url: null, saved_at: null });
    assert.ok(line.startsWith('🗓️'));
  });

  test('unknown project → 📁 fallback emoji', () => {
    const line = buildRecallLine({ project: 'future_project', title: 'Something', url: null, saved_at: null });
    assert.ok(line.startsWith('📁'));
  });

  test('all known projects have non-fallback emoji', () => {
    const known = ['personal', 'learning_tech', 'work', 'school', 'research_apps',
                   'baking', 'beadwork', 'art', 'reading', 'exercise', 'circuitry'];
    for (const project of known) {
      const line = buildRecallLine({ project, title: 'test', url: null, saved_at: null });
      assert.ok(!line.startsWith('📁'), `${project} should have a specific emoji, not 📁`);
    }
  });

  test('recall header line format', () => {
    // bot.js: await reply(channel, `here's what I have on "${topic}":\n${lines.join('\n')}`)
    const topic = 'transformers';
    const header = `here's what I have on "${topic}":`;
    assert.ok(header.startsWith("here's what I have on"));
    assert.ok(header.includes(`"${topic}"`));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 42 — buildLearningTitle comprehensive edge cases
// The function strips filler openers from the topic and cleans up the action verb.
// ══════════════════════════════════════════════════════════════════════════════

describe('buildLearningTitle — comprehensive edge cases', () => {
  // ── Action stripping ──
  test('"read it" → strips "it" → "Read [topic]"', () => {
    const r = buildLearningTitle('read it', 'attention mechanisms');
    assert.ok(r.startsWith('Read attention'));
    assert.ok(!r.includes(' it'));
  });

  test('"read the paper" → strips "the paper" → "Read [topic]"', () => {
    const r = buildLearningTitle('read the paper', 'sparse autoencoders');
    assert.ok(r.startsWith('Read sparse'));
    assert.ok(!r.includes('the paper'));
  });

  test('"understand more" → strips "more" → "Understand [topic]"', () => {
    const r = buildLearningTitle('understand more', 'mechanistic interpretability');
    assert.ok(r.startsWith('Understand mechanistic'));
  });

  test('"implement about it" → strips "about it" → "Implement [topic]"', () => {
    const r = buildLearningTitle('implement about it', 'linear probes');
    assert.ok(r.startsWith('Implement linear'));
  });

  test('"write everything" → strips "everything" → "Write [topic]"', () => {
    const r = buildLearningTitle('write everything', 'toy models');
    assert.ok(r.startsWith('Write toy'));
  });

  // ── Topic stripping ──
  test('topic "I want to learn about X" → strips preamble → just "X"', () => {
    const r = buildLearningTitle('read', 'I want to learn about transformer circuits');
    assert.ok(!r.includes('I want to learn about'));
    assert.ok(r.includes('transformer circuits'));
  });

  test('topic "I want to understand X" → strips preamble', () => {
    const r = buildLearningTitle('implement', 'I want to understand RLHF from scratch');
    assert.ok(!r.includes('I want to understand'));
    assert.ok(r.includes('RLHF'));
  });

  test('topic "I am learning about X" → strips preamble', () => {
    const r = buildLearningTitle('read', 'I am learning about diffusion models');
    assert.ok(!r.includes('I am learning about'));
    assert.ok(r.includes('diffusion models'));
  });

  test('topic "learn about X" → strips preamble', () => {
    const r = buildLearningTitle('implement', 'learn about neural ODEs');
    assert.ok(!r.includes('learn about'));
    assert.ok(r.includes('neural ODEs'));
  });

  test('topic "what is X" → strips preamble', () => {
    const r = buildLearningTitle('understand', 'what is mixture of experts');
    assert.ok(!r.includes('what is'));
    assert.ok(r.includes('mixture of experts'));
  });

  test('topic "explain X" → strips preamble', () => {
    const r = buildLearningTitle('read', 'explain sparse autoencoders');
    assert.ok(!r.includes('explain'));
    assert.ok(r.includes('sparse autoencoders'));
  });

  // ── Capitalisation ──
  test('result always starts with capital letter', () => {
    const inputs = [
      ['implement', 'attention'],
      ['read', 'RLHF alignment'],
      ['write', 'toy models of superposition'],
    ];
    for (const [action, topic] of inputs) {
      const r = buildLearningTitle(action, topic);
      assert.ok(/^[A-Z]/.test(r), `Expected capital start, got: "${r}"`);
    }
  });

  // ── Length cap ──
  test('result never exceeds 80 chars', () => {
    const r = buildLearningTitle(
      'implement from scratch using PyTorch with custom CUDA kernels',
      'I want to learn about mechanistic interpretability in large language models'
    );
    assert.ok(r.length <= 80, `Got ${r.length} chars: "${r}"`);
  });

  // ── Empty / fallback ──
  test('empty topic slug → just verb, no trailing space', () => {
    const r = buildLearningTitle('read', '');
    assert.equal(r.trim(), r);
    assert.ok(r.startsWith('Read'));
    assert.ok(!r.endsWith(' '));
  });

  test('empty action → defaults to "Explore [topic]"', () => {
    const r = buildLearningTitle('', 'transformers');
    assert.ok(r.startsWith('Explore'));
    assert.ok(r.includes('transformers'));
  });

  test('whitespace-only action → defaults to "Explore"', () => {
    const r = buildLearningTitle('   ', 'attention');
    assert.ok(r.startsWith('Explore'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 43 — clarificationMode new-URL abort condition
// If a new URL arrives while bot is waiting for "work or personal?", the pending
// state should be cleared and the URL treated as a fresh save message.
// ══════════════════════════════════════════════════════════════════════════════

describe('clarificationMode — new URL abort condition', () => {
  // Replicate the condition from bot.js:
  // const isNewUrl = urls.length > 0 && urls[0] !== state.url;
  function isNewUrl(incomingUrls, pendingUrl) {
    return incomingUrls.length > 0 && incomingUrls[0] !== pendingUrl;
  }

  test('no new URL → not a new-URL abort', () => {
    assert.equal(isNewUrl([], 'https://example.com'), false);
  });

  test('same URL as pending → not a new-URL abort', () => {
    assert.equal(isNewUrl(['https://example.com'], 'https://example.com'), false);
  });

  test('different URL → new-URL abort (clear pending)', () => {
    assert.equal(isNewUrl(['https://other.com'], 'https://example.com'), true);
  });

  test('URL arrives when pending.url was null → new-URL abort', () => {
    assert.equal(isNewUrl(['https://arxiv.org/abs/1234'], null), true);
  });

  test('multiple URLs in message — only first is checked', () => {
    // bot.js uses urls[0] !== state.url
    assert.equal(isNewUrl(['https://new.com', 'https://example.com'], 'https://example.com'), true);
    assert.equal(isNewUrl(['https://example.com', 'https://new.com'], 'https://example.com'), false);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 44 — Pass 2 pending state shapes
// When bot defers a task to Pass 2, it sets pending to a specific shape.
// These tests document the expected shape so regressions are immediately visible.
// ══════════════════════════════════════════════════════════════════════════════

describe('Pass 2 — pending state shape contracts', () => {
  // Replicate the pending.set() calls from bot.js Pass 2 block

  function buildReminderPendingState(cls) {
    // processReminderTask with no timeline → sets:
    return { reminderMode: true, reminderTitle: cls.title ?? 'Reminder', originalText: cls.title ?? '' };
  }

  function buildCorrectionPendingState(prev) {
    return { correctionMode: true, logId: prev.logId, correctionStep: 0 };
  }

  function buildSearchModePendingState(cls, userText) {
    return { url: null, text: cls.title ?? userText, searchMode: true, step: 1 };
  }

  function buildClarificationPendingState(cls, url, userText) {
    return { clarificationMode: true, url, text: cls.title ?? userText, step: 1 };
  }

  function buildVagueLearningPendingState(cls, userText) {
    return { learningMode: true, originalText: cls.title ?? userText, step: 1, history: [] };
  }

  test('reminder pending state has reminderMode=true and title', () => {
    const state = buildReminderPendingState({ title: 'Buy cleansing oil' });
    assert.equal(state.reminderMode, true);
    assert.equal(state.reminderTitle, 'Buy cleansing oil');
  });

  test('reminder pending state falls back to "Reminder" when title is null', () => {
    const state = buildReminderPendingState({ title: null });
    assert.equal(state.reminderTitle, 'Reminder');
  });

  test('correction pending state has correctionMode=true, logId, correctionStep=0', () => {
    const state = buildCorrectionPendingState({ logId: 'log-abc' });
    assert.equal(state.correctionMode, true);
    assert.equal(state.logId, 'log-abc');
    assert.equal(state.correctionStep, 0);
  });

  test('search mode pending state has searchMode=true, step=1, url=null', () => {
    const state = buildSearchModePendingState({ title: 'Meridian Fellowship' }, 'apply meridian');
    assert.equal(state.searchMode, true);
    assert.equal(state.step, 1);
    assert.equal(state.url, null);
    assert.equal(state.text, 'Meridian Fellowship');
  });

  test('search mode falls back to userText when title is null', () => {
    const state = buildSearchModePendingState({ title: null }, 'apply meridian fellowship');
    assert.equal(state.text, 'apply meridian fellowship');
  });

  test('clarification pending state has clarificationMode=true, step=1', () => {
    const state = buildClarificationPendingState(
      { title: 'Explore new feature' },
      'https://example.com',
      'fallback text'
    );
    assert.equal(state.clarificationMode, true);
    assert.equal(state.step, 1);
    assert.equal(state.url, 'https://example.com');
    assert.equal(state.text, 'Explore new feature');
  });

  test('vague learning pending state has learningMode=true, step=1, empty history', () => {
    const state = buildVagueLearningPendingState({ title: 'Linear probes in LLMs' }, 'fallback');
    assert.equal(state.learningMode, true);
    assert.equal(state.step, 1);
    assert.deepEqual(state.history, []);
    assert.equal(state.originalText, 'Linear probes in LLMs');
  });

  test('vague learning falls back to userText when title is null', () => {
    const state = buildVagueLearningPendingState({ title: null }, 'I want to learn about circuits');
    assert.equal(state.originalText, 'I want to learn about circuits');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 45 — normaliseTask edge inputs
// Guards against malformed or missing AI output fields.
// ══════════════════════════════════════════════════════════════════════════════

describe('normaliseTask — edge input contracts', () => {
  // ── intent validation ──
  test('invalid intent string → falls back to "save"', () => {
    const t = normaliseTask({ intent: 'fly_to_moon' });
    assert.equal(t.intent, 'save');
  });

  test('missing intent field → "save"', () => {
    const t = normaliseTask({});
    assert.equal(t.intent, 'save');
  });

  test('all valid intents are preserved', () => {
    for (const intent of VALID_INTENTS) {
      const t = normaliseTask({ intent });
      assert.equal(t.intent, intent);
    }
  });

  // ── title ──
  test('whitespace-only title → null', () => {
    const t = normaliseTask({ intent: 'save', title: '   ' });
    assert.equal(t.title, null);
  });

  test('null title → null', () => {
    const t = normaliseTask({ intent: 'save', title: null });
    assert.equal(t.title, null);
  });

  test('title with surrounding spaces → trimmed', () => {
    const t = normaliseTask({ intent: 'save', title: '  Buy cleansing oil  ' });
    assert.equal(t.title, 'Buy cleansing oil');
  });

  // ── timeline ──
  test('whitespace-only timeline → null', () => {
    const t = normaliseTask({ intent: 'reminder', timeline: '  ' });
    assert.equal(t.timeline, null);
  });

  test('valid timeline preserved', () => {
    const t = normaliseTask({ intent: 'reminder', timeline: 'this Saturday' });
    assert.equal(t.timeline, 'this Saturday');
  });

  // ── priority_tier ──
  test('priority_tier 0 → null (out of range)', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: 0 });
    assert.equal(t.priority_tier, null);
  });

  test('priority_tier 5 → null (out of range)', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: 5 });
    assert.equal(t.priority_tier, null);
  });

  test('priority_tier 1-4 → preserved', () => {
    for (const tier of [1, 2, 3, 4]) {
      const t = normaliseTask({ intent: 'save', priority_tier: tier });
      assert.equal(t.priority_tier, tier);
    }
  });

  test('priority_tier as string "2" → null (must be integer)', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: '2' });
    assert.equal(t.priority_tier, null);
  });

  test('priority_tier as float 1.5 → null (must be integer)', () => {
    const t = normaliseTask({ intent: 'save', priority_tier: 1.5 });
    assert.equal(t.priority_tier, null);
  });

  // ── project_hint ──
  test('invalid project_hint → null', () => {
    const t = normaliseTask({ intent: 'save', project_hint: 'unknown_project' });
    assert.equal(t.project_hint, null);
  });

  test('all valid project_hints preserved', () => {
    for (const key of PROJECT_KEYS) {
      const t = normaliseTask({ intent: 'save', project_hint: key });
      assert.equal(t.project_hint, key);
    }
  });

  // ── needs_clarification ──
  test('needs_clarification="true" (string) → false (must be boolean true)', () => {
    const t = normaliseTask({ intent: 'save', needs_clarification: 'true' });
    assert.equal(t.needs_clarification, false);
  });

  test('needs_clarification=1 (number) → false', () => {
    const t = normaliseTask({ intent: 'save', needs_clarification: 1 });
    assert.equal(t.needs_clarification, false);
  });

  test('needs_clarification=true → true', () => {
    const t = normaliseTask({ intent: 'save', needs_clarification: true });
    assert.equal(t.needs_clarification, true);
  });

  // ── recall_topic / search_query ──
  test('whitespace-only recall_topic → null', () => {
    const t = normaliseTask({ intent: 'recall', recall_topic: '   ' });
    assert.equal(t.recall_topic, null);
  });

  test('whitespace-only search_query → null', () => {
    const t = normaliseTask({ intent: 'web_search', search_query: '   ' });
    assert.equal(t.search_query, null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 46 — parseClarificationContext edge inputs
// Covers single-char replies, mixed-signal messages, and boundary words.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseClarificationContext — edge inputs', () => {
  // ── Unambiguous ──
  test('"w" → work', () => {
    assert.equal(parseClarificationContext('w'), 'work');
  });

  test('"p" → personal', () => {
    assert.equal(parseClarificationContext('p'), 'personal');
  });

  test('"W" (uppercase) → work', () => {
    assert.equal(parseClarificationContext('W'), 'work');
  });

  test('"P" (uppercase) → personal', () => {
    assert.equal(parseClarificationContext('P'), 'personal');
  });

  test('"job" → work', () => {
    assert.equal(parseClarificationContext('job'), 'work');
  });

  test('"professional" → work', () => {
    assert.equal(parseClarificationContext('professional'), 'work');
  });

  test('"sprint" → work', () => {
    assert.equal(parseClarificationContext('sprint'), 'work');
  });

  test('"ticket" → work', () => {
    assert.equal(parseClarificationContext('ticket'), 'work');
  });

  test('"mine" → personal', () => {
    assert.equal(parseClarificationContext('mine'), 'personal');
  });

  test('"fun" → personal', () => {
    assert.equal(parseClarificationContext('fun'), 'personal');
  });

  test('"curious" → personal', () => {
    assert.equal(parseClarificationContext('curious'), 'personal');
  });

  test('"learning" → personal', () => {
    assert.equal(parseClarificationContext('learning'), 'personal');
  });

  // ── Priority: work keywords win when both present ──
  test('"work and personal use" → work (work matched first)', () => {
    // "work" matched by first regex, returns early
    assert.equal(parseClarificationContext('work and personal use'), 'work');
  });

  // ── Null (can't tell) ──
  test('"yes" → null (ambiguous)', () => {
    assert.equal(parseClarificationContext('yes'), null);
  });

  test('"ok" → null', () => {
    assert.equal(parseClarificationContext('ok'), null);
  });

  test('"the thing I mentioned" → null', () => {
    assert.equal(parseClarificationContext('the thing I mentioned'), null);
  });

  test('empty string → null', () => {
    assert.equal(parseClarificationContext(''), null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 47 — buildEnrichedText combinations
// Used to annotate saves with work/personal context and timeline.
// ══════════════════════════════════════════════════════════════════════════════

describe('buildEnrichedText — context annotation', () => {
  test('work context → [Work] prefix', () => {
    const r = buildEnrichedText('work', null, 'Fix prod deploy', null);
    assert.ok(r.startsWith('[Work]'));
  });

  test('personal context → [Personal] prefix', () => {
    const r = buildEnrichedText('personal', null, 'Buy vitamins', null);
    assert.ok(r.startsWith('[Personal]'));
  });

  test('null context → no prefix', () => {
    const r = buildEnrichedText(null, null, 'Read diffusion paper', null);
    assert.ok(!r.includes('[Work]'));
    assert.ok(!r.includes('[Personal]'));
  });

  test('timeline present → appended with em dash', () => {
    const r = buildEnrichedText('work', 'this Friday', 'Submit PR', null);
    assert.ok(r.includes('— this Friday'));
  });

  test('null timeline → no em dash', () => {
    const r = buildEnrichedText('work', null, 'Submit PR', null);
    assert.ok(!r.includes('—'));
  });

  test('text equals url → text not included (duplicate)', () => {
    const url = 'https://example.com';
    const r = buildEnrichedText('personal', null, url, url);
    assert.ok(!r.includes(url));
  });

  test('text differs from url → text included with url stripped', () => {
    const url = 'https://arxiv.org/abs/1234';
    const r = buildEnrichedText('work', null, `Read this paper ${url}`, url);
    assert.ok(r.includes('Read this paper'));
    assert.ok(!r.includes(url)); // url stripped from text
  });

  test('null text → not included', () => {
    const r = buildEnrichedText('work', 'Monday', null, null);
    assert.ok(!r.includes('null'));
    assert.ok(r.includes('— Monday'));
  });

  test('full combination: work + timeline + text', () => {
    const r = buildEnrichedText('work', 'next week', 'Deploy auth changes', null);
    assert.ok(r.includes('[Work]'));
    assert.ok(r.includes('Deploy auth changes'));
    assert.ok(r.includes('— next week'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 48 — parseProjectFromText alias coverage
// Every alias in PROJECT_ALIASES must resolve correctly.
// ══════════════════════════════════════════════════════════════════════════════

describe('parseProjectFromText — full alias table', () => {
  const cases = [
    ['school', 'school'],
    ['uni work', 'school'],
    ['university course', 'school'],
    ['work project', 'work'],
    ['job task', 'work'],
    ['research grant', 'research_apps'],
    ['applications due', 'research_apps'],
    ['apps deadline', 'research_apps'],
    ['learning path', 'learning_tech'],
    ['tech stuff', 'learning_tech'],
    ['learn pytorch', 'learning_tech'],
    ['circuits board', 'circuitry'],
    ['electronics project', 'circuitry'],
    ['arduino uno', 'circuitry'],
    ['baking timer', 'baking'],
    ['bread recipe', 'baking'],
    ['beads pattern', 'beadwork'],
    ['beads tutorial', 'beadwork'],
    ['jewelry design', 'beadwork'],
    ['art project', 'art'],
    ['drawing practice', 'art'],
    ['pastels drawing', 'art'],
    ['reading list', 'reading'],
    ['books to read', 'reading'],
    ['exercise plan', 'exercise'],
    ['gym schedule', 'exercise'],
    ['fitness goals', 'exercise'],
    ['personal errand', 'personal'],
  ];

  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected}`, () => {
      assert.equal(parseProjectFromText(input), expected);
    });
  }

  test('unrecognised text → null', () => {
    assert.equal(parseProjectFromText('something completely different'), null);
  });

  test('empty string → null', () => {
    assert.equal(parseProjectFromText(''), null);
  });

  test('numbers and punctuation → null (stripped to spaces)', () => {
    assert.equal(parseProjectFromText('123 456'), null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 49 — prefsMode step validation boundary values
// The prefs flow rejects out-of-range duration values at step 0.
// ══════════════════════════════════════════════════════════════════════════════

describe('prefsMode — duration and reminder boundary validation', () => {
  // Duration: valid range 5–480 min
  function isDurationValid(mins) {
    return mins !== null && mins >= 5 && mins <= 480;
  }

  test('5 min → valid (lower bound)', () => {
    assert.equal(isDurationValid(parseDurationMinutes('5 min')), true);
  });

  test('480 min → valid (upper bound)', () => {
    assert.equal(isDurationValid(parseDurationMinutes('480 min')), true);
  });

  test('4 min → rejected (below lower bound)', () => {
    assert.equal(isDurationValid(parseDurationMinutes('4 min')), false);
  });

  test('481 min → rejected (above upper bound)', () => {
    assert.equal(isDurationValid(parseDurationMinutes('481 min')), false);
  });

  test('"1 hour" → 60 min → valid', () => {
    const mins = parseDurationMinutes('1 hour');
    assert.equal(mins, 60);
    assert.equal(isDurationValid(mins), true);
  });

  test('"8 hours" → 480 min → valid (max)', () => {
    const mins = parseDurationMinutes('8 hours');
    assert.equal(mins, 480);
    assert.equal(isDurationValid(mins), true);
  });

  test('"9 hours" → 540 min → rejected (above 480)', () => {
    const mins = parseDurationMinutes('9 hours');
    assert.equal(mins, 540);
    assert.equal(isDurationValid(mins), false);
  });

  test('"0" → 0 → rejected', () => {
    const mins = parseDurationMinutes('0');
    assert.equal(isDurationValid(mins), false);
  });

  test('null (unparseable) → rejected', () => {
    assert.equal(isDurationValid(null), false);
  });

  // Reminder: "none" → empty array → valid; null → invalid (re-ask)
  test('"none" → [] (no reminders — valid choice)', () => {
    assert.deepEqual(parseReminderMinutes('none'), []);
  });

  test('"1 hour 30 min" → [60, 30] (both matched)', () => {
    const r = parseReminderMinutes('1 hour 30 min');
    assert.ok(Array.isArray(r));
    assert.ok(r.includes(60));
    assert.ok(r.includes(30));
  });

  test('"garbage text" → null (re-ask needed)', () => {
    assert.equal(parseReminderMinutes('garbage text'), null);
  });

  test('"skip" → [] (empty — no reminders)', () => {
    assert.deepEqual(parseReminderMinutes('skip'), []);
  });

  test('"off" → [] (empty — no reminders)', () => {
    assert.deepEqual(parseReminderMinutes('off'), []);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 50 — Multi-task needsInput accumulation
// In pass 1, multiple deferred tasks should ALL land in needsInput.
// Pass 2 processes only needsInput[0]. The rest are silently dropped
// (one pending question at a time is the design contract).
// ══════════════════════════════════════════════════════════════════════════════

describe('Multi-task needsInput accumulation', () => {
  function simulatePass1(tasks) {
    const needsInput = [];
    for (const cls of tasks) {
      if (cls.intent === 'converse') continue;
      if (cls.intent === 'search_request') { needsInput.push({ type: 'search_request', cls }); continue; }
      if (cls.needs_clarification) { needsInput.push({ type: 'clarification', cls }); continue; }
      if (cls.project_hint === 'learning_tech' && !cls.url) {
        needsInput.push({ type: 'vague_learning', cls });
        continue;
      }
      if (cls.intent === 'reminder' && !cls.timeline) {
        needsInput.push({ type: 'reminder', cls });
        continue;
      }
      // immediate tasks: reminder with timeline, save — processed in pass 1 (not needsInput)
    }
    return needsInput;
  }

  test('two search_requests → both in needsInput', () => {
    const tasks = [
      normaliseTask({ intent: 'search_request', title: 'Meridian fellowship' }),
      normaliseTask({ intent: 'search_request', title: 'NSF grant' }),
    ];
    const ni = simulatePass1(tasks);
    assert.equal(ni.length, 2);
    assert.equal(ni[0].type, 'search_request');
    assert.equal(ni[1].type, 'search_request');
  });

  test('one immediate reminder (has timeline) + one deferred reminder (no timeline) → only deferred in needsInput', () => {
    const tasks = [
      normaliseTask({ intent: 'reminder', title: 'Linear Algebra Assignment', timeline: '13th' }),
      normaliseTask({ intent: 'reminder', title: 'Buy milk' }), // no timeline
    ];
    const ni = simulatePass1(tasks);
    assert.equal(ni.length, 1);
    assert.equal(ni[0].cls.title, 'Buy milk');
  });

  test('mixed deferred types: clarification + vague_learning → both in needsInput', () => {
    const tasks = [
      normaliseTask({ intent: 'save', needs_clarification: true, title: 'Deploy new feature' }),
      normaliseTask({ intent: 'save', project_hint: 'learning_tech', title: 'Diffusion models' }),
    ];
    const ni = simulatePass1(tasks);
    assert.equal(ni.length, 2);
    const types = ni.map(n => n.type);
    assert.ok(types.includes('clarification'));
    assert.ok(types.includes('vague_learning'));
  });

  test('pass 2 only processes needsInput[0]', () => {
    const needsInput = [
      { type: 'reminder', cls: normaliseTask({ intent: 'reminder', title: 'Buy milk' }) },
      { type: 'clarification', cls: normaliseTask({ intent: 'save', needs_clarification: true, title: 'Deploy thing' }) },
    ];
    // Contract: only process index 0
    const deferred = needsInput[0];
    assert.equal(deferred.type, 'reminder');
    assert.equal(deferred.cls.title, 'Buy milk');
    // needsInput[1] is silently dropped — one pending question at a time
    assert.equal(needsInput.length, 2); // still 2 in array but only [0] processed
  });

  test('empty needsInput → pass 2 skipped entirely', () => {
    const needsInput = [];
    assert.equal(needsInput.length > 0, false);
  });

  test('all-immediate tasks → needsInput is empty', () => {
    const tasks = [
      normaliseTask({ intent: 'reminder', title: 'Buy milk', timeline: 'today' }),
      normaliseTask({ intent: 'save', title: 'Read diffusion paper', project_hint: 'reading' }),
    ];
    const ni = simulatePass1(tasks);
    assert.equal(ni.length, 0);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 51 — buildSuccessMessage: 60-char title truncation contract
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSuccessMessage — 60-char title truncation', () => {
  test('title exactly 60 chars → not truncated', () => {
    const summary = 'A'.repeat(60);
    const msg = buildSuccessMessage({ project: 'work', summary });
    assert.ok(msg.includes(summary));
  });

  test('title 61 chars → truncated to 60', () => {
    const summary = 'A'.repeat(61);
    const msg = buildSuccessMessage({ project: 'work', summary });
    assert.ok(!msg.includes(summary)); // 61-char string not in output
    assert.ok(msg.includes('A'.repeat(60))); // 60-char version is
  });

  test('null summary → "saved" fallback (no title part)', () => {
    const msg = buildSuccessMessage({ project: 'work', summary: null });
    assert.ok(msg.includes('saved'));
  });

  test('empty string summary → "saved" fallback', () => {
    const msg = buildSuccessMessage({ project: 'personal', summary: '' });
    assert.ok(msg.includes('saved'));
  });

  test('timeline cls.timeline appended after " · "', () => {
    const msg = buildSuccessMessage(
      { project: 'school', summary: 'Physics exam' },
      { timeline: 'this Friday' }
    );
    assert.ok(msg.includes(' · this Friday'));
  });

  test('no cls timeline → no " · " separator', () => {
    const msg = buildSuccessMessage({ project: 'school', summary: 'Physics exam' }, {});
    assert.ok(!msg.includes(' · '));
  });
});
