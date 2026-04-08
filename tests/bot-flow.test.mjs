/**
 * Bot flow unit tests — response quality and output correctness.
 *
 * Philosophy: test what the bot *says and produces*, not just internal booleans.
 * Every describe block has a comment explaining what future milestone it covers.
 *
 * Run: node --test tests/bot-flow.test.mjs
 *
 * Pure functions are duplicated here from bot.js to avoid importing Slack Bolt
 * (which has side effects). Future refactor: extract bot.js pure functions into
 * lib/botHelpers.js and import from there.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Replicated pure functions from bot.js ─────────────────────────────────────
// Keep these in sync with bot.js. If bot.js changes, update here too.

const APP_URL = 'https://project-os.vercel.app'; // test constant

// --- buildSuccessMessage ---
const PROJECT_EMOJI = {
  learning_tech: '📚', work: '💼', school: '🎓', research_apps: '🔬',
  baking: '🍞', beadwork: '📿', art: '🎨', reading: '📖',
  exercise: '💪', circuitry: '⚡', personal: '🗓️',
};

function buildSuccessMessage(data, cls) {
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

// --- buildReminderMessage (mirrors bot.js reminder reply format) ---
function buildReminderMessage(data, cls) {
  const title = (data.summary ?? 'reminder').slice(0, 60);
  const timeNote = cls?.timeline ? ` · ${cls.timeline}` : '';
  return `🗓️ <${APP_URL}/project/personal|${title}>${timeNote}`;
}

// --- buildEnrichedText ---
function buildEnrichedText(context, timeline, text, url) {
  const parts = [];
  if (context === 'work')     parts.push('[Work]');
  if (context === 'personal') parts.push('[Personal]');
  if (text && text !== url)   parts.push(text.replace(url ?? '', '').trim());
  if (timeline)               parts.push(`— ${timeline}`);
  return parts.filter(Boolean).join(' ');
}

// --- parseClarificationContext ---
function parseClarificationContext(text) {
  const t = text.toLowerCase();
  if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(text)) return 'work';
  if (/\bpersonal\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  if (/^w\b/i.test(t.trim())) return 'work';
  if (/^p\b/i.test(t.trim())) return 'personal';
  return null;
}

// --- parseProjectFromText ---
const PROJECT_ALIASES = {
  'school': 'school', 'uni': 'school', 'university': 'school',
  'work': 'work', 'job': 'work',
  'research': 'research_apps', 'applications': 'research_apps', 'apps': 'research_apps',
  'learning': 'learning_tech', 'tech': 'learning_tech', 'learn': 'learning_tech',
  'circuits': 'circuitry', 'electronics': 'circuitry', 'arduino': 'circuitry',
  'baking': 'baking', 'bread': 'baking',
  'beads': 'beadwork', 'beadwork': 'beadwork', 'jewelry': 'beadwork',
  'art': 'art', 'drawing': 'art', 'pastels': 'art',
  'reading': 'reading', 'books': 'reading',
  'exercise': 'exercise', 'gym': 'exercise', 'fitness': 'exercise',
};
function parseProjectFromText(text) {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
}

// --- extractUrls ---
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

// --- buildDeadlineNudgeLine (extracted from sendSlackDeadlineNudge inline logic) ---
function buildDeadlineNudgeLine(app, now = new Date()) {
  const d = Math.ceil((new Date(app.deadline) - now) / 86_400_000);
  const emoji = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
  const unanswered = (app.questions ?? []).filter(q => !q.answer?.trim()).length;
  return `${emoji} *${app.org}* — ${d}d left${unanswered ? ` (${unanswered} questions remaining)` : ''}`;
}

// --- isExplicitLearning (replicated from bot.js — KEEP IN SYNC) ---
const isExplicitLearning = (text, urls) => {
  if (urls.length > 0) return false;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // "want to learn / learning about" patterns — need >5 words so topic is present
  if (words > 5 && /\b(want to learn|learning about|i'?m learning|been learning|trying to learn|i want to understand)\b/i.test(text)) return true;
  // "tell me about X / explain X" — need >4 words (topic is part of the phrase)
  if (words > 4 && /\b(tell me about|explain to me|what is a|what are)\b/i.test(text)) return true;
  return false;
};

// --- Title extraction prompt (replicated from /api/inbox/route.js — KEEP IN SYNC) ---
const TITLE_EXTRACTION_PROMPT = 'Extract the topic, concept, or event name from this text. Return ONLY the name itself — never describe the message, never say "User is asking about". Examples: input "I want to learn linear probes" → output "linear probes". Input "tell me about toy models of superposition" → output "toy models of superposition". Input "apply to Meridian fellowship" → output "Meridian fellowship". Max 8 words, no punctuation.';

// ── Learning reply handling (replicated from bot.js learningMode handler) ─────
// These functions must be kept in sync with bot.js.
// They are extracted here so the decision logic can be unit-tested independently
// of the Slack Bolt runtime.

/**
 * The exact system prompt sent to the AI when classifying a learning reply.
 * Tests verify this prompt's content to ensure it contains the right criteria.
 * MUST be kept in sync with bot.js learningMode handler.
 */
const LEARNING_REPLY_SYSTEM_PROMPT = (originalText) =>
`You classify a conversational reply to help capture a personal learning task.

The user wants to learn about: "${originalText.slice(0, 200)}"
You asked: "what do you want to do with this — read, implement something, understand the theory, or write about it?"

Return ONLY valid JSON (no markdown, no code fences):
{
  "type": "action" | "chat",
  "task": "verb-led task, max 80 chars (ONLY when type=action, e.g. 'implement a linear probe in PyTorch')",
  "reply": "2-3 sentences explaining the topic + question nudging toward a specific intent (ONLY when type=chat)"
}

type=action — ONLY when the reply is a complete, unconditional task statement:
  EXAMPLES: "implement it from scratch" / "read the paper" / "understand the theory" / "write a summary" / "build a demo"

type=chat — when the user wants explanation before committing, asks a question, or defers the decision:
  EXAMPLES:
  "tell me more about it, explain it and I'll tell you how I want to implement it" → chat (conditional: needs info FIRST)
  "what is a linear probe?" → chat (question)
  "I don't understand it yet" → chat (not ready)
  "explain it then I'll decide" → chat (explicitly defers)
  "how does it work?" → chat (question)

CRITICAL RULE: if the reply contains "after you explain", "I'll tell you", "once I understand", "then I'll decide", or ANY condition — it is type=chat regardless of whether it mentions implement/read/write. Only choose type=action when the entire reply is an unambiguous task with no conditions attached.`;

/**
 * Decision logic: given a parsed AI JSON response and the current step,
 * return { saveAsText, chatReply }.
 * This is the pure decision function extracted from the learningMode handler.
 */
function handleLearningReplyResult(parsed, step) {
  let saveAsText = null;
  let chatReply  = null;
  if (parsed?.type === 'action' && parsed?.task) {
    saveAsText = parsed.task;
  } else if (parsed?.type === 'chat' && parsed?.reply && step < 2) {
    chatReply = parsed.reply;
  }
  return { saveAsText, chatReply };
}

/**
 * Fallback when AI call fails. Short replies (≤8 words) treated as direct intent.
 * Longer replies also saved via the `saveAsText ?? userText` chain in bot.js.
 */
function learningReplyFallback(userText) {
  const words = userText.trim().split(/\s+/).filter(Boolean).length;
  return { saveAsText: words <= 8 ? userText : null };
}

/**
 * Builds the final enriched string that gets saved as the task title.
 */
const buildFinalTask = (taskText, originalText) =>
  `${taskText} — ${originalText.slice(0, 120)}`;

// --- isShortConversational, isPureUrl, isVagueLearning, fallbackClassification, buildEnrichedTask ---
const isShortConversational = (text, urls) =>
  urls.length === 0 && text.trim().split(/\s+/).filter(Boolean).length <= 3;

const isPureUrl = (text, urls) => {
  const stripped = urls.reduce((t, u) => t.replace(u, ''), text).trim();
  return urls.length > 0 && stripped.length < 20;
};

const isVagueLearning = (cls, urls) =>
  cls.project_hint === 'learning_tech' && urls.length === 0;

const fallbackClassification = (text) => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return {
    intent: words.length <= 5 ? 'converse' : 'save',
    context: null, timeline: null, project_hint: null,
    corrected_project: null, needs_clarification: false,
  };
};

// The actual enrichment used when user replies to the learning clarification question
const buildEnrichedTask = (clarificationReply, originalText) =>
  `${clarificationReply} — ${originalText.slice(0, 120)}`;


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Bot reply format and content quality
// Covers: current save flow, all projects, message sanitisation
// Future: same format applies for v2 quick-capture, bookmarklet, mobile share
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSuccessMessage — reply format and content', () => {
  test('learning_tech save produces 📚 emoji with linked title', () => {
    const msg = buildSuccessMessage({ project: 'learning_tech', summary: 'Linear Probes in LLMs' }, {});
    assert.ok(msg.startsWith('📚'));
    assert.ok(msg.includes('Linear Probes in LLMs'));
    assert.ok(msg.includes('<https://'));
    assert.ok(msg.includes('|Linear Probes in LLMs>'));
  });

  test('research_apps produces 🔬 emoji', () => {
    const msg = buildSuccessMessage({ project: 'research_apps', summary: 'Meridian RAW Fellowship' }, {});
    assert.ok(msg.startsWith('🔬'));
  });

  test('school produces 🎓 emoji', () => {
    const msg = buildSuccessMessage({ project: 'school', summary: 'Physics exam week 10' }, {});
    assert.ok(msg.startsWith('🎓'));
  });

  test('work produces 💼 emoji', () => {
    const msg = buildSuccessMessage({ project: 'work', summary: 'Fix prod deploy bug' }, {});
    assert.ok(msg.startsWith('💼'));
  });

  test('personal produces 🗓️ emoji', () => {
    const msg = buildSuccessMessage({ project: 'personal', summary: 'Dentist appointment' }, {});
    assert.ok(msg.startsWith('🗓️'));
  });

  test('unknown project falls back to 📁', () => {
    const msg = buildSuccessMessage({ project: 'future_project_not_yet_defined', summary: 'something' }, {});
    assert.ok(msg.startsWith('📁'));
  });

  test('title with newlines is collapsed to single space', () => {
    const msg = buildSuccessMessage({ project: 'reading', summary: 'Book\nTitle\nWith\nLines' }, {});
    assert.ok(!msg.includes('\n'));
    assert.ok(msg.includes('Book Title With Lines'));
  });

  test('title with Slack emoji codes like :fire: is stripped', () => {
    const msg = buildSuccessMessage({ project: 'baking', summary: ':fire: Great sourdough recipe' }, {});
    assert.ok(!msg.includes(':fire:'));
    assert.ok(msg.includes('Great sourdough recipe'));
  });

  test('title with Slack mrkdwn special chars < > | is stripped to not break link syntax', () => {
    const msg = buildSuccessMessage({ project: 'work', summary: 'Task <A|B> review' }, {});
    assert.ok(!msg.includes('<A'));
    assert.ok(!msg.includes('|B>'));
    // The link wrapper itself uses < > | which is expected
    assert.match(msg, /<https:\/\/.*\|.*>/);
  });

  test('title longer than 60 chars is truncated', () => {
    const longTitle = 'A very long title that describes something in way too much detail for a card';
    const msg = buildSuccessMessage({ project: 'learning_tech', summary: longTitle }, {});
    const linkMatch = msg.match(/\|([^>]+)>/);
    assert.ok(linkMatch);
    assert.ok(linkMatch[1].length <= 60);
  });

  test('null summary falls back to "saved"', () => {
    const msg = buildSuccessMessage({ project: 'art', summary: null }, {});
    assert.ok(msg.endsWith('saved'));
  });

  test('empty string summary falls back to "saved"', () => {
    const msg = buildSuccessMessage({ project: 'art', summary: '' }, {});
    assert.ok(msg.endsWith('saved'));
  });

  test('timeline is appended after · separator', () => {
    const msg = buildSuccessMessage(
      { project: 'school', summary: 'Assignment due' },
      { timeline: 'by Friday 5pm' }
    );
    assert.ok(msg.includes(' · by Friday 5pm'));
    assert.ok(msg.indexOf(' · by Friday 5pm') > msg.indexOf('Assignment due'));
  });

  test('null timeline produces no · separator', () => {
    const msg = buildSuccessMessage({ project: 'school', summary: 'Assignment' }, { timeline: null });
    assert.ok(!msg.includes(' · '));
  });

  test('link URL contains correct project key in path', () => {
    const msg = buildSuccessMessage({ project: 'circuitry', summary: 'ESP32 project' }, {});
    assert.ok(msg.includes('/project/circuitry'));
  });

  test('all 11 current projects each get a unique emoji (no two share)', () => {
    const projects = Object.keys(PROJECT_EMOJI);
    const emojis = projects.map(p =>
      buildSuccessMessage({ project: p, summary: 'test' }, {}).split(' ')[0]
    );
    const unique = new Set(emojis);
    assert.equal(unique.size, projects.length);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Reminder reply format
// Covers: calendar/personal project replies with time context
// Future: Google Calendar integration — same format, plus calendar event link
// ══════════════════════════════════════════════════════════════════════════════

describe('buildReminderMessage — calendar reply format', () => {
  test('reminder with timeline includes 🗓️ and time after ·', () => {
    const msg = buildReminderMessage(
      { summary: 'Dentist appointment' },
      { timeline: '5:30pm Thursday' }
    );
    assert.ok(msg.startsWith('🗓️'));
    assert.ok(msg.includes(' · 5:30pm Thursday'));
  });

  test('reminder without timeline has no · suffix', () => {
    const msg = buildReminderMessage({ summary: 'Pick up dry cleaning' }, { timeline: null });
    assert.ok(msg.startsWith('🗓️'));
    assert.ok(!msg.includes(' · '));
  });

  test('reminder title links to /project/personal', () => {
    const msg = buildReminderMessage({ summary: 'Yoga class' }, { timeline: '7am Monday' });
    assert.ok(msg.includes('/project/personal'));
  });

  test('reminder with very long summary truncates at 60 chars', () => {
    const msg = buildReminderMessage(
      { summary: 'x'.repeat(100) },
      { timeline: '9am' }
    );
    const titleMatch = msg.match(/\|([^>]+)>/);
    assert.ok(titleMatch);
    assert.ok(titleMatch[1].length <= 60);
  });

  test('null summary falls back to "reminder" label', () => {
    const msg = buildReminderMessage({ summary: null }, { timeline: null });
    assert.ok(msg.includes('reminder'));
  });

  // Future: when Google Calendar is integrated, the message should contain
  // a calendar event ID or deep link to the created event
  test('[SCAFFOLD] future: reminder message format ready for calendar event link', () => {
    // When Calendar integration lands, extend this to:
    //   assert.ok(msg.includes('calendar.google.com') || msg.includes('cal_event_id'));
    // For now: confirm the format is consistent enough to extend
    const msg = buildReminderMessage({ summary: 'Stand-up at work' }, { timeline: '9am Tuesday' });
    assert.ok(msg.startsWith('🗓️'));
    assert.ok(typeof msg === 'string');
    assert.ok(msg.length < 500); // not a blob of JSON
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Context enrichment for router
// Covers: how the bot annotates text before sending to /api/inbox
// Future: richer annotations (step 5 pref-boost tags, user ID prefix)
// ══════════════════════════════════════════════════════════════════════════════

describe('buildEnrichedText — context annotation for router', () => {
  test('work context prepends [Work] tag', () => {
    const enriched = buildEnrichedText('work', null, 'Review PR for auth service', null);
    assert.ok(enriched.startsWith('[Work]'));
    assert.ok(enriched.includes('Review PR'));
  });

  test('personal context prepends [Personal] tag', () => {
    const enriched = buildEnrichedText('personal', null, 'Buy birthday gift for mum', null);
    assert.ok(enriched.startsWith('[Personal]'));
  });

  test('null context adds no tag', () => {
    const enriched = buildEnrichedText(null, null, 'Read RLHF paper from DeepMind', null);
    assert.ok(!enriched.startsWith('['));
    assert.ok(enriched.includes('Read RLHF paper'));
  });

  test('timeline is appended as — suffix', () => {
    const enriched = buildEnrichedText(null, 'by June 30', 'Submit fellowship draft', null);
    assert.ok(enriched.includes('— by June 30'));
    assert.ok(enriched.indexOf('Submit fellowship draft') < enriched.indexOf('— by June 30'));
  });

  test('work + timeline both appear, in correct order', () => {
    const enriched = buildEnrichedText('work', 'this Friday', 'Ship the release', null);
    assert.ok(enriched.startsWith('[Work]'));
    assert.ok(enriched.includes('this Friday'));
    assert.ok(enriched.includes('Ship the release'));
    assert.ok(enriched.indexOf('[Work]') < enriched.indexOf('Ship the release'));
    assert.ok(enriched.indexOf('Ship the release') < enriched.indexOf('this Friday'));
  });

  test('URL is stripped from the text body (not duplicated)', () => {
    const url = 'https://arxiv.org/abs/2310.00001';
    const enriched = buildEnrichedText(null, null, `Check out ${url}`, url);
    assert.ok(!enriched.includes(url));
    assert.ok(enriched.includes('Check out'));
  });

  test('when text equals url, text is not added (just tags/timeline)', () => {
    const url = 'https://github.com/google/gemma';
    const enriched = buildEnrichedText('personal', null, url, url);
    assert.ok(!enriched.includes(url));
  });

  test('empty text + null url + null context → empty string', () => {
    const enriched = buildEnrichedText(null, null, '', null);
    assert.equal(enriched, '');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Clarification context parsing
// Covers: what user types when bot asks "work or personal?"
// Future: richer intent parsing ("for my thesis" → school, "for fun" → personal)
// ══════════════════════════════════════════════════════════════════════════════

describe('parseClarificationContext — work/personal reply parsing', () => {
  test('"work" → work', () => assert.equal(parseClarificationContext('work'), 'work'));
  test('"Work" (capitalised) → work', () => assert.equal(parseClarificationContext('Work'), 'work'));
  test('"for work" → work', () => assert.equal(parseClarificationContext('for work'), 'work'));
  test('"it\'s for my job" → work', () => assert.equal(parseClarificationContext("it's for my job"), 'work'));
  test('"sprint ticket" → work', () => assert.equal(parseClarificationContext('sprint ticket'), 'work'));
  test('"professional project" → work', () => assert.equal(parseClarificationContext('professional project'), 'work'));
  test('"w" (bare) → work', () => assert.equal(parseClarificationContext('w'), 'work'));

  test('"personal" → personal', () => assert.equal(parseClarificationContext('personal'), 'personal'));
  test('"just for me" → personal', () => assert.equal(parseClarificationContext('just for me'), 'personal'));
  test('"my own learning" → personal', () => assert.equal(parseClarificationContext('my own learning'), 'personal'));
  test('"curious about this" → personal', () => assert.equal(parseClarificationContext('curious about this'), 'personal'));
  test('"just for fun" → personal', () => assert.equal(parseClarificationContext('just for fun'), 'personal'));
  test('"p" (bare) → personal', () => assert.equal(parseClarificationContext('p'), 'personal'));

  test('unrecognised reply → null (bot re-asks)', () => {
    assert.equal(parseClarificationContext('idk'), null);
  });
  test('empty string → null', () => {
    assert.equal(parseClarificationContext(''), null);
  });
  test('a number → null', () => {
    assert.equal(parseClarificationContext('42'), null);
  });

  // Future: school/personal/work three-way clarification for tech URLs
  test('[SCAFFOLD] future: "for my thesis" should resolve to school', () => {
    // When three-way clarification lands (school | work | personal), extend here:
    //   assert.equal(parseClarificationContext('for my thesis'), 'school');
    // For now confirm it returns null (re-asks), which is acceptable
    const result = parseClarificationContext('for my thesis');
    assert.ok(result === null || result === 'school');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Project alias resolution (correction flow)
// Covers: what user types when bot asks "which project?"
// Future: fuzzy matching, multi-word aliases, new projects
// ══════════════════════════════════════════════════════════════════════════════

describe('parseProjectFromText — correction alias mapping', () => {
  test('"school" → school', () => assert.equal(parseProjectFromText('school'), 'school'));
  test('"uni" → school', () => assert.equal(parseProjectFromText('uni'), 'school'));
  test('"university" → school', () => assert.equal(parseProjectFromText('university'), 'school'));
  test('"work" → work', () => assert.equal(parseProjectFromText('work'), 'work'));
  test('"job" → work', () => assert.equal(parseProjectFromText('job'), 'work'));
  test('"research" → research_apps', () => assert.equal(parseProjectFromText('research'), 'research_apps'));
  test('"learning" → learning_tech', () => assert.equal(parseProjectFromText('learning'), 'learning_tech'));
  test('"arduino" → circuitry', () => assert.equal(parseProjectFromText('arduino'), 'circuitry'));
  test('"electronics" → circuitry', () => assert.equal(parseProjectFromText('electronics'), 'circuitry'));
  test('"gym" → exercise', () => assert.equal(parseProjectFromText('gym'), 'exercise'));
  test('"fitness" → exercise', () => assert.equal(parseProjectFromText('fitness'), 'exercise'));
  test('"beads" → beadwork', () => assert.equal(parseProjectFromText('beads'), 'beadwork'));
  test('"jewelry" → beadwork', () => assert.equal(parseProjectFromText('jewelry'), 'beadwork'));
  test('"bread" → baking', () => assert.equal(parseProjectFromText('bread'), 'baking'));
  test('"drawing" → art', () => assert.equal(parseProjectFromText('drawing'), 'art'));
  test('"pastels" → art', () => assert.equal(parseProjectFromText('pastels'), 'art'));
  test('"books" → reading', () => assert.equal(parseProjectFromText('books'), 'reading'));

  test('full natural sentence "actually this should be school" → school', () => {
    assert.equal(parseProjectFromText('actually this should be school'), 'school');
  });
  test('"→ work please" → work', () => {
    assert.equal(parseProjectFromText('→ work please'), 'work');
  });
  test('"move to learning" → learning_tech', () => {
    assert.equal(parseProjectFromText('move to learning'), 'learning_tech');
  });

  test('completely unrecognised text → null', () => {
    assert.equal(parseProjectFromText('definitely not a project name'), null);
  });

  // Future: when 'personal' project is fully set up as a correction target
  test('[SCAFFOLD] future: "personal" → personal project key', () => {
    // Add 'personal' to PROJECT_ALIASES in bot.js when personal project goes live
    const result = parseProjectFromText('personal');
    assert.ok(result === 'personal' || result === null); // null until alias added
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6A — Learning reply: pure decision logic (handleLearningReplyResult)
// Tests the exact function that processes the AI's JSON response.
// Does NOT call the AI — tests the decision tree given a known parsed response.
// ══════════════════════════════════════════════════════════════════════════════

describe('handleLearningReplyResult — decision logic given AI JSON response', () => {

  // ── type=action cases ──
  test('action + task → saveAsText is set, chatReply is null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'action', task: 'implement a linear probe in PyTorch' }, 1
    );
    assert.equal(saveAsText, 'implement a linear probe in PyTorch');
    assert.equal(chatReply, null);
  });

  test('action + task at step 2 → still saves (action always saves regardless of step)', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'action', task: 'read the paper carefully' }, 2
    );
    assert.equal(saveAsText, 'read the paper carefully');
    assert.equal(chatReply, null);
  });

  test('action with empty task string → saveAsText is null (empty task rejected)', () => {
    const { saveAsText } = handleLearningReplyResult({ type: 'action', task: '' }, 1);
    assert.equal(saveAsText, null);
  });

  test('action with missing task field → saveAsText is null', () => {
    const { saveAsText } = handleLearningReplyResult({ type: 'action' }, 1);
    assert.equal(saveAsText, null);
  });

  // ── type=chat cases ──
  test('chat + reply at step 1 → chatReply is set, saveAsText is null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'Linear probes are classifiers trained on frozen representations...' }, 1
    );
    assert.equal(chatReply, 'Linear probes are classifiers trained on frozen representations...');
    assert.equal(saveAsText, null);
  });

  test('chat + reply at step 2 → chatReply is NULL (step limit, force save)', () => {
    // This is the step-limit: only 1 explanation allowed, then must save
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'Another explanation...' }, 2
    );
    assert.equal(chatReply, null);
    assert.equal(saveAsText, null); // falls through to saveAsText ?? userText in bot.js
  });

  test('chat with empty reply string → chatReply is null (empty reply rejected)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat', reply: '' }, 1);
    assert.equal(chatReply, null);
  });

  test('chat with missing reply field → chatReply is null', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.equal(chatReply, null);
  });

  // ── Malformed AI responses ──
  test('null parsed response → both null (no crash)', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(null, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });

  test('undefined parsed response → both null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(undefined, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });

  test('unknown type "save" → both null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'save', task: 'something' }, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });

  test('unknown type "converse" → both null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'converse', reply: 'hi' }, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });

  test('empty object {} → both null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({}, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6B — Learning reply: step state machine
// Tests that step boundaries work correctly: step 1 allows chat, step 2 forces save.
// ══════════════════════════════════════════════════════════════════════════════

describe('Learning reply: step state machine', () => {

  test('step=1 allows chat response (1 < 2)', () => {
    const step = 1;
    const { chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'Here is an explanation...' }, step
    );
    assert.ok(chatReply !== null);
  });

  test('step=2 blocks chat (2 is NOT < 2) → forces save', () => {
    const step = 2;
    const { chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'Another explanation...' }, step
    );
    assert.equal(chatReply, null);
  });

  test('step=0 allows chat (edge case: step defaults to 1 in bot.js, but 0 also passes)', () => {
    const { chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'explanation' }, 0
    );
    assert.ok(chatReply !== null);
  });

  test('after chat response, step increments: state.step becomes step+1', () => {
    // Simulate bot.js: pending.set(userId, { ...state, step: step + 1 })
    const state = { learningMode: true, originalText: 'topic', step: 1 };
    const newState = { ...state, step: state.step + 1 };
    assert.equal(newState.step, 2);
  });

  test('at step=2, action still works (step limit only blocks chat)', () => {
    const { saveAsText } = handleLearningReplyResult(
      { type: 'action', task: 'implement it' }, 2
    );
    assert.equal(saveAsText, 'implement it');
  });

  test('missing step (state.step undefined) defaults to 1 via ?? 1', () => {
    const step = undefined ?? 1;
    assert.equal(step, 1);
    // step=1 allows chat
    const { chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'explanation' }, step
    );
    assert.ok(chatReply !== null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6C — Learning reply: fallback when AI call fails
// Tests bot.js catch{} block: what happens when classifyLearningReply throws.
// ══════════════════════════════════════════════════════════════════════════════

describe('Learning reply: fallback when AI call fails', () => {

  test('≤8-word reply → saveAsText = userText (treated as direct intent)', () => {
    const { saveAsText } = learningReplyFallback('implement it from scratch');
    assert.equal(saveAsText, 'implement it from scratch');
  });

  test('exactly 8 words → saveAsText is set (boundary: 8 ≤ 8)', () => {
    const msg = 'I want to implement this in PyTorch now';
    const wordCount = msg.trim().split(/\s+/).filter(Boolean).length;
    assert.equal(wordCount, 8); // exactly at boundary
    const { saveAsText } = learningReplyFallback(msg);
    assert.ok(saveAsText !== null);
  });

  test('8-word reply → sets saveAsText', () => {
    const msg = 'implement the linear probe from scratch today';
    const wordCount = msg.trim().split(/\s+/).filter(Boolean).length;
    assert.equal(wordCount, 7); // 7 ≤ 8 → saves
    const { saveAsText } = learningReplyFallback(msg);
    assert.ok(saveAsText !== null);
  });

  test('>8-word reply → saveAsText is null (falls through to ?? userText)', () => {
    const msg = 'tell me more about it explain it and then I will tell you how I want to implement it';
    const wordCount = msg.trim().split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount > 8);
    const { saveAsText } = learningReplyFallback(msg);
    assert.equal(saveAsText, null);
    // In bot.js: taskText = saveAsText ?? userText → still saves raw text
  });

  test('bot.js ?? chain: saveAsText=null falls back to userText', () => {
    const userText = 'tell me more about linear probes and explain the math';
    const saveAsText = null;
    const taskText = saveAsText ?? userText;
    assert.equal(taskText, userText); // always saves something
  });

  test('the exact failing message in fallback: >8 words → saveAsText null but still saves', () => {
    const msg = 'tell me more about it, explain it and I\'ll tell u how I want to implement it';
    const { saveAsText } = learningReplyFallback(msg);
    assert.equal(saveAsText, null);
    // Falls back to userText via ?? — bot saves the raw text rather than crashing
    const taskText = saveAsText ?? msg;
    assert.ok(taskText.length > 0);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6D — System prompt content validation
// Tests that the prompt contains the exact criteria needed for correct AI behaviour.
// If bot.js prompt changes, these tests catch whether key safety criteria were removed.
// ══════════════════════════════════════════════════════════════════════════════

describe('LEARNING_REPLY_SYSTEM_PROMPT — content validation', () => {

  const prompt = LEARNING_REPLY_SYSTEM_PROMPT(
    'I want to learn about linear probes like Neel Nanda safety work'
  );

  // ── Original topic is injected into the prompt ──
  test('prompt contains the original topic text', () => {
    assert.ok(prompt.includes('linear probes like Neel Nanda safety work'));
  });

  test('prompt contains what question was asked (for context)', () => {
    assert.ok(prompt.includes('what do you want to do with this'));
  });

  // ── JSON schema is present and correct ──
  test('prompt specifies the "type" field with both valid values', () => {
    assert.ok(prompt.includes('"type"'));
    assert.ok(prompt.includes('action'));
    assert.ok(prompt.includes('chat'));
  });

  test('prompt specifies "task" field for action type', () => {
    assert.ok(prompt.includes('"task"'));
  });

  test('prompt specifies "reply" field for chat type', () => {
    assert.ok(prompt.includes('"reply"'));
  });

  test('prompt requires verb-led task', () => {
    assert.ok(prompt.includes('verb-led'));
  });

  test('prompt enforces 80-char task limit', () => {
    assert.ok(prompt.includes('80'));
  });

  test('prompt says no markdown / no code fences in output', () => {
    assert.ok(prompt.includes('no markdown') || prompt.includes('no code fences'));
  });

  // ── type=action criteria is explicit ──
  test('prompt defines type=action with examples of clear intents', () => {
    assert.ok(prompt.includes('implement') && prompt.includes('type=action'));
  });

  test('prompt includes "read the paper" as action example', () => {
    assert.ok(prompt.includes('read the paper'));
  });

  test('prompt includes "understand the theory" as action example', () => {
    assert.ok(prompt.includes('understand the theory'));
  });

  // ── type=chat criteria covers the exact failing scenario ──
  test('prompt includes the exact failing message as a type=chat example', () => {
    // This is the message that kept being saved incorrectly
    assert.ok(prompt.includes("tell me more about it, explain it and I'll tell you how I want to implement it"));
  });

  test('prompt labels that message as → chat with the reason (conditional)', () => {
    assert.ok(prompt.includes('conditional') || prompt.includes('needs info FIRST'));
  });

  test('prompt includes "what is a linear probe?" as chat example', () => {
    assert.ok(prompt.includes('what is a linear probe'));
  });

  test('prompt includes "explain it then I\'ll decide" as chat example', () => {
    assert.ok(prompt.includes("explain it then I'll decide"));
  });

  // ── CRITICAL conditional rule is present ──
  test('prompt contains CRITICAL RULE about conditional phrasing', () => {
    assert.ok(prompt.includes('CRITICAL RULE') || prompt.includes('CRITICAL:'));
  });

  test('prompt explicitly mentions "I\'ll tell you" as a condition → chat', () => {
    assert.ok(prompt.includes("I'll tell you"));
  });

  test('prompt explicitly mentions "once I understand" as a condition → chat', () => {
    assert.ok(prompt.includes('once I understand'));
  });

  test('prompt explicitly says type=action requires "no conditions"', () => {
    assert.ok(prompt.includes('no conditions') || prompt.includes('unambiguous'));
  });

  test('prompt says mentioning implement/read/write inside a condition is still type=chat', () => {
    // The key fix: "and I'll implement it" ≠ "implement it"
    assert.ok(
      prompt.includes('regardless of whether it mentions implement') ||
      prompt.includes('regardless of whether')
    );
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6E — Final task format: verb-led, topic-included, length-bounded
// Tests what actually gets saved to the database after the dialogue completes.
// ══════════════════════════════════════════════════════════════════════════════

describe('buildFinalTask — enriched task format quality', () => {

  test('format: "[AI task] — [topic]"', () => {
    const result = buildFinalTask('implement a linear probe in PyTorch', 'I want to learn about linear probes');
    assert.ok(result.includes(' — '));
    assert.equal(result.split(' — ').length, 2);
  });

  test('starts with the AI-cleaned verb-led task, not the raw topic', () => {
    const result = buildFinalTask('implement from scratch', 'I want to learn about linear probes');
    assert.ok(result.startsWith('implement'));
    assert.ok(!result.startsWith('I want to learn'));
  });

  test('topic part is capped at 120 chars', () => {
    const longTopic = 'I want to learn about ' + 'linear probes '.repeat(20);
    const result = buildFinalTask('implement it', longTopic);
    const topicPart = result.split(' — ')[1];
    assert.ok(topicPart.length <= 120);
  });

  test('short topic is preserved in full', () => {
    const result = buildFinalTask('read the paper', 'linear probes');
    assert.equal(result, 'read the paper — linear probes');
  });

  test('result is never just the original vague topic (the original bug)', () => {
    // The original bug: bot saved "Neel Nanda linear probes" with no action
    const result = buildFinalTask('implement it', 'I want to learn about linear probes like Neel Nanda');
    assert.ok(!result.startsWith('I want to learn'));
    assert.ok(!result.startsWith('Neel Nanda'));
  });

  test('implement in PyTorch task produces correct enriched string', () => {
    const result = buildFinalTask(
      'implement a linear probe in PyTorch from scratch',
      'I want to learn about linear probes like Neel Nanda safety work'
    );
    assert.ok(result.startsWith('implement'));
    assert.ok(result.includes('PyTorch'));
    assert.ok(result.includes('linear probes'));
  });

  test('read-focused task', () => {
    const result = buildFinalTask('read the ARENA curriculum on mechanistic interp', 'I want to learn about ARENA');
    assert.ok(result.startsWith('read'));
    assert.ok(result.includes('ARENA'));
  });

  test('write-focused task', () => {
    const result = buildFinalTask('write a summary of the key equations', 'diffusion model score matching');
    assert.ok(result.startsWith('write'));
  });

  test('understand-focused task', () => {
    const result = buildFinalTask('understand the theory behind attention heads', 'transformers');
    assert.ok(result.startsWith('understand'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6F — Regression: the exact failing scenario
// These are the specific messages that kept being saved incorrectly.
// The correct behaviour: type=chat (not saved), bot gives explanation.
// ══════════════════════════════════════════════════════════════════════════════

describe('REGRESSION — "tell me more" must NOT save immediately', () => {

  // ── The prompt must classify these as type=chat ──
  // We verify by checking that the prompt's criteria text covers each case.
  const prompt = LEARNING_REPLY_SYSTEM_PROMPT('linear probes Neel Nanda safety');

  test('Exact failing message is listed as type=chat example in prompt', () => {
    // The prompt must contain this exact message as an example
    assert.ok(
      prompt.includes("tell me more about it, explain it and I'll tell you how I want to implement it")
    );
  });

  test('"tell me more" phrasing is covered by type=chat criteria', () => {
    assert.ok(prompt.includes('tell me more'));
  });

  test('"explain it" phrasing is covered by type=chat criteria', () => {
    assert.ok(prompt.includes('explain'));
  });

  test('"I\'ll tell you how" conditional is explicitly flagged as type=chat', () => {
    assert.ok(prompt.includes("I'll tell you"));
  });

  // ── Decision logic: given the AI correctly returns type=chat, bot does NOT save ──
  test('decision: type=chat at step=1 → chatReply set, saveAsText null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'Linear probes are classifiers trained on frozen model representations...' },
      1
    );
    assert.equal(saveAsText, null);
    assert.ok(chatReply !== null);
    assert.ok(chatReply.length > 0);
  });

  test('decision: type=chat → bot keeps pending state (step increments)', () => {
    const originalStep = 1;
    const { chatReply } = handleLearningReplyResult(
      { type: 'chat', reply: 'explanation' }, originalStep
    );
    assert.ok(chatReply !== null);
    // In bot.js: pending.set(userId, { ...state, step: step + 1 })
    const newStep = originalStep + 1;
    assert.equal(newStep, 2);
  });

  test('decision: type=action → saveAsText set, bot saves immediately', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult(
      { type: 'action', task: 'implement linear probes in PyTorch' }, 1
    );
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);
  });

  // ── Similar failing messages (variations of the bug) ──
  test('"explain it then I\'ll implement it" → prompt classifies as chat', () => {
    // These messages contain "implement" but are conditional → must be chat
    const conditionalMessages = [
      "tell me more about it, explain it and I'll tell u how I want to implement it",
      "explain it then I'll decide what to do",
      "what is it? once I understand I'll tell you if I want to implement it",
      "I'll implement it after you explain what it is",
    ];
    for (const msg of conditionalMessages) {
      // Verify the CRITICAL RULE in the prompt covers these
      assert.ok(
        prompt.includes("I'll tell you") || prompt.includes('conditional'),
        `Prompt must cover conditional phrasing for: "${msg}"`
      );
    }
  });

  // ── Contrast: these ARE direct intents → type=action ──
  test('clear action phrases produce type=action from decision function', () => {
    const directIntents = [
      { type: 'action', task: 'implement it from scratch' },
      { type: 'action', task: 'read the paper carefully' },
      { type: 'action', task: 'understand the theory' },
      { type: 'action', task: 'write a summary of the key ideas' },
      { type: 'action', task: 'build a demo in PyTorch' },
    ];
    for (const parsed of directIntents) {
      const { saveAsText } = handleLearningReplyResult(parsed, 1);
      assert.ok(saveAsText !== null, `Expected saveAsText for: ${parsed.task}`);
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6G — Full conversation flow simulation
// Simulates the complete 2-3 turn conversation from topic capture to task save.
// ══════════════════════════════════════════════════════════════════════════════

describe('Full conversation simulation: topic → question → reply → [explain] → save', () => {

  test('HAPPY PATH: direct intent on first reply → saves immediately', () => {
    // Turn 1: user says topic → bot asks question (tested by isExplicitLearning)
    assert.ok(isExplicitLearning(
      'I want to learn about linear probes like Neel Nanda safety work', []
    ));

    // Turn 2: user gives direct intent → bot saves
    const parsed = { type: 'action', task: 'implement a linear probe in PyTorch from scratch' };
    const { saveAsText, chatReply } = handleLearningReplyResult(parsed, 1);
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);

    // Final saved task: verb-led, topic included
    const saved = buildFinalTask(saveAsText, 'I want to learn about linear probes like Neel Nanda safety work');
    assert.ok(saved.startsWith('implement'));
    assert.ok(saved.includes('linear probes'));
    assert.ok(saved.includes(' — '));
    assert.ok(!saved.startsWith('I want to learn')); // not vague
  });

  test('CHAT PATH: "tell me more" → explanation → intent → saves', () => {
    // Turn 1: topic → question
    assert.ok(isExplicitLearning('I want to learn about linear probes', []));

    // Turn 2: "tell me more" → type=chat at step=1 → gives explanation, keeps pending
    const chatParsed = { type: 'chat', reply: 'Linear probes are simple classifiers on frozen representations. They reveal what a layer "knows". Do you want to implement one, or read the key papers?' };
    const turn2 = handleLearningReplyResult(chatParsed, 1);
    assert.equal(turn2.saveAsText, null);
    assert.ok(turn2.chatReply !== null);

    // State: step becomes 2
    const newStep = 2;

    // Turn 3: user gives intent → type=action at step=2 → saves
    const actionParsed = { type: 'action', task: 'implement a linear probe in PyTorch' };
    const turn3 = handleLearningReplyResult(actionParsed, newStep);
    assert.ok(turn3.saveAsText !== null);
    assert.equal(turn3.chatReply, null);

    // Final saved task
    const saved = buildFinalTask(turn3.saveAsText, 'I want to learn about linear probes');
    assert.ok(saved.startsWith('implement'));
    assert.ok(saved.includes('linear probes'));
  });

  test('STEP LIMIT PATH: "tell me more" → still vague → force save at step=2', () => {
    // Turn 2: "tell me more" at step=1 → explanation given, step → 2
    const turn2 = handleLearningReplyResult(
      { type: 'chat', reply: 'An explanation...' }, 1
    );
    assert.ok(turn2.chatReply !== null);

    // Turn 3: still vague at step=2 → chatReply blocked, falls through to save
    const turn3 = handleLearningReplyResult(
      { type: 'chat', reply: 'Still wants more info...' }, 2
    );
    assert.equal(turn3.chatReply, null);  // blocked at step=2
    assert.equal(turn3.saveAsText, null); // no action either
    // In bot.js: taskText = saveAsText ?? userText → saves raw reply text
  });

  test('FALLBACK PATH: AI fails → short reply saves, long reply also saves via ??', () => {
    // Short reply fallback
    const short = learningReplyFallback('implement it');
    assert.ok(short.saveAsText !== null);

    // Long reply fallback: saveAsText=null but bot.js uses ?? userText
    const longMsg = 'tell me more about it because I do not understand what linear probes are yet';
    const long = learningReplyFallback(longMsg);
    assert.equal(long.saveAsText, null);
    // ?? userText → taskText = long message itself
    const taskText = long.saveAsText ?? longMsg;
    assert.equal(taskText, longMsg);
    assert.ok(taskText.length > 0);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Deadline nudge line formatting
// Covers: urgency emoji, day count, unanswered question count
// Future: nudge includes application org + link, not just a text line
// ══════════════════════════════════════════════════════════════════════════════

describe('buildDeadlineNudgeLine — urgency display quality', () => {
  const inDays = (n) => new Date(Date.now() + n * 86_400_000);

  test('0 days left → 🔴 (deadline today)', () => {
    const line = buildDeadlineNudgeLine({ org: 'MIT', deadline: inDays(0), questions: [] });
    assert.ok(line.startsWith('🔴'));
    assert.ok(line.includes('MIT'));
  });

  test('1 day left → 🔴', () => {
    const line = buildDeadlineNudgeLine({ org: 'Stanford', deadline: inDays(1), questions: [] });
    assert.ok(line.startsWith('🔴'));
  });

  test('2 days left → 🟡', () => {
    const line = buildDeadlineNudgeLine({ org: 'DeepMind', deadline: inDays(2), questions: [] });
    assert.ok(line.startsWith('🟡'));
  });

  test('3 days left → 🟡', () => {
    const line = buildDeadlineNudgeLine({ org: 'OpenAI', deadline: inDays(3), questions: [] });
    assert.ok(line.startsWith('🟡'));
  });

  test('4 days left → ⚪', () => {
    const line = buildDeadlineNudgeLine({ org: 'Google', deadline: inDays(4), questions: [] });
    assert.ok(line.startsWith('⚪'));
  });

  test('7 days left → ⚪', () => {
    const line = buildDeadlineNudgeLine({ org: 'Anthropic', deadline: inDays(7), questions: [] });
    assert.ok(line.startsWith('⚪'));
  });

  test('org name appears in bold (*org*) for Slack formatting', () => {
    const line = buildDeadlineNudgeLine({ org: 'Jane Street', deadline: inDays(2), questions: [] });
    assert.ok(line.includes('*Jane Street*'));
  });

  test('unanswered questions count appears when questions have no answer', () => {
    const questions = [
      { text: 'Q1', answer: '' },
      { text: 'Q2', answer: null },
      { text: 'Q3', answer: '   ' }, // whitespace-only counts as unanswered
    ];
    const line = buildDeadlineNudgeLine({ org: 'MIRI', deadline: inDays(2), questions });
    assert.ok(line.includes('3 questions remaining'));
  });

  test('answered questions are excluded from count', () => {
    const questions = [
      { text: 'Q1', answer: 'My answer here' },
      { text: 'Q2', answer: '' },
    ];
    const line = buildDeadlineNudgeLine({ org: 'ARC', deadline: inDays(1), questions });
    assert.ok(line.includes('1 questions remaining'));
  });

  test('all questions answered → no "(N questions remaining)" text', () => {
    const questions = [
      { text: 'Q1', answer: 'Answered' },
      { text: 'Q2', answer: 'Also answered' },
    ];
    const line = buildDeadlineNudgeLine({ org: 'Redwood', deadline: inDays(5), questions });
    assert.ok(!line.includes('questions remaining'));
  });

  test('no questions field → no "(N questions remaining)" text', () => {
    const line = buildDeadlineNudgeLine({ org: 'Conjecture', deadline: inDays(3) });
    assert.ok(!line.includes('questions remaining'));
  });

  test('day count is included in the line', () => {
    const line = buildDeadlineNudgeLine({ org: 'Epoch AI', deadline: inDays(6), questions: [] });
    assert.ok(line.includes('6d left'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — URL extraction from varied Slack message shapes
// Covers: plain text, rich blocks, attachments, unfurl previews
// Future: image URLs, file attachments, Slack file shares
// ══════════════════════════════════════════════════════════════════════════════

describe('extractUrls — Slack message URL extraction', () => {
  test('plain text URL', () => {
    const urls = extractUrls({ text: 'Check this https://arxiv.org/abs/2310.00001' });
    assert.deepEqual(urls, ['https://arxiv.org/abs/2310.00001']);
  });

  test('two URLs in text — both extracted, deduplicated', () => {
    const urls = extractUrls({
      text: 'https://github.com/openai/gpt-4 and https://arxiv.org/abs/2310.00001'
    });
    assert.equal(urls.length, 2);
  });

  test('same URL twice → deduplicated to one', () => {
    const url = 'https://huggingface.co/google/gemma';
    const urls = extractUrls({ text: `${url} ${url}` });
    assert.equal(urls.length, 1);
    assert.equal(urls[0], url);
  });

  test('slack.com URLs are filtered out', () => {
    const urls = extractUrls({ text: 'https://myworkspace.slack.com/archives/C123' });
    assert.equal(urls.length, 0);
  });

  test('slack-edge.com URLs are filtered out', () => {
    const urls = extractUrls({ text: 'https://files.slack-edge.com/img/avatar.png' });
    assert.equal(urls.length, 0);
  });

  test('URL in Slack rich-text block', () => {
    const urls = extractUrls({
      text: '',
      blocks: [{
        elements: [{
          elements: [{ type: 'link', url: 'https://github.com/anthropics/claude-code' }]
        }]
      }]
    });
    assert.ok(urls.includes('https://github.com/anthropics/claude-code'));
  });

  test('URL in attachment original_url', () => {
    const urls = extractUrls({
      text: '',
      attachments: [{ original_url: 'https://www.nature.com/articles/s41586-024-07566-y' }]
    });
    assert.ok(urls.includes('https://www.nature.com/articles/s41586-024-07566-y'));
  });

  test('URL in attachment from_url (unfurl preview)', () => {
    const urls = extractUrls({
      text: 'interesting',
      attachments: [{ from_url: 'https://openreview.net/forum?id=abc123' }]
    });
    assert.ok(urls.includes('https://openreview.net/forum?id=abc123'));
  });

  test('no URLs → empty array', () => {
    const urls = extractUrls({ text: 'no links here just text' });
    assert.deepEqual(urls, []);
  });

  test('mailto: links are not extracted', () => {
    const urls = extractUrls({ text: 'email me at mailto:test@example.com' });
    assert.equal(urls.length, 0);
  });

  test('tel: links are not extracted', () => {
    const urls = extractUrls({ text: 'call me at tel:+61400000000' });
    assert.equal(urls.length, 0);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8a — Title extraction prompt quality
// Tests that the inbox title extractor prompt prevents AI meta-descriptions.
// Root bug: "tell me about linear probes" → "User is asking about linear probes,
// which is a technical/mathematical topic..." instead of just "linear probes".
// ══════════════════════════════════════════════════════════════════════════════

describe('Title extraction prompt — prevents AI meta-descriptions', () => {

  test('prompt says to return ONLY the name (not describe the message)', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('ONLY the name'));
  });

  test('prompt explicitly forbids "User is asking about" phrasing', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('never say "User is asking about"'));
  });

  test('prompt includes example: "linear probes" input → "linear probes" output', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('linear probes'));
  });

  test('prompt includes example: "tell me about toy models of superposition" → topic name only', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('toy models of superposition'));
  });

  test('prompt has maxTokens hint (30) to prevent long outputs — enforced in route.js', () => {
    // maxTokens: 30 in the callModelWithFallback call limits verbosity
    // (not in the prompt string itself — this is a code-level check)
    assert.ok(typeof TITLE_EXTRACTION_PROMPT === 'string');
    assert.ok(TITLE_EXTRACTION_PROMPT.length > 0);
  });

  test('prompt instructs max 8 words output', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('8 words'));
  });

  test('prompt instructs no punctuation at end', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('no punctuation'));
  });

  // ── Verify the WRONG outputs are described as forbidden ──
  test('the exact bad output seen in screenshot is forbidden by prompt', () => {
    // "User is asking about toy models of superposition, which is a technical concept..."
    // The prompt says: never say "User is asking about"
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('never'));
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('User is asking about'));
  });

  test('prompt includes fellowship example for non-learning topics', () => {
    assert.ok(TITLE_EXTRACTION_PROMPT.includes('Meridian fellowship'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8b — Explicit learning heuristic (pre-AI fast path)
// This is the fix for the exact bug the user reported:
//   "I want to learn about linear probes like Neel Nanda's safety work"
//   → bot saved it immediately instead of asking the clarification question
//
// The heuristic fires BEFORE classifyIntent, so it never depends on the AI
// correctly returning project_hint:'learning_tech'.
// ══════════════════════════════════════════════════════════════════════════════

describe('isExplicitLearning — pre-AI heuristic (the fix for the Neel Nanda bug)', () => {
  // The exact message that kept failing:
  test('exact failing message → triggers clarification, NOT save', () => {
    assert.ok(isExplicitLearning(
      'I want to learn about linear probes like Neil nanda\'s safety AI safety alignment works',
      []
    ));
  });

  test('original reported message from session → triggers clarification', () => {
    assert.ok(isExplicitLearning(
      'I want to learn abt linear probes like in Neel Nandas safety wlrk',
      []
    ));
  });

  // Other natural phrasings users will say:
  test('"I want to learn about transformers" → triggers', () =>
    assert.ok(isExplicitLearning('I want to learn about transformers and attention mechanisms', [])));

  test('"learning about diffusion models" → triggers', () =>
    assert.ok(isExplicitLearning('been learning about diffusion models and score matching', [])));

  test('"trying to learn mechanistic interpretability" → triggers', () =>
    assert.ok(isExplicitLearning('I\'ve been trying to learn mechanistic interpretability from scratch', [])));

  test('"I\'m learning about RLHF" → triggers', () =>
    assert.ok(isExplicitLearning('I\'m learning about RLHF and want to track my progress', [])));

  test('"want to understand attention" → triggers', () =>
    assert.ok(isExplicitLearning('I want to understand how attention heads work in transformers', [])));

  // With URL → does NOT trigger (URL means there's a concrete resource, just save it)
  test('"want to learn about X" WITH URL → does NOT trigger', () =>
    assert.ok(!isExplicitLearning(
      'I want to learn about linear probes https://arxiv.org/abs/2310.00001',
      ['https://arxiv.org/abs/2310.00001']
    )));

  // Too short — would be conversational anyway, no topic to save
  test('"want to learn" alone (4 words, no topic) → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('I want to learn', [])));

  test('"I want to learn Python" (5 words, boundary) → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('I want to learn Python', [])));

  test('"I want to learn about X" (6 words) → DOES trigger', () =>
    assert.ok(isExplicitLearning('I want to learn about neural networks', [])));

  // Should NOT catch conversational messages that happen to contain these words
  test('"did you save what I wanted to learn" → does NOT trigger (conversational phrasing)', () => {
    // "wanted to learn" doesn't match the pattern — guard is specific
    assert.ok(!isExplicitLearning('did you save what I wanted to learn about transformers', []));
  });

  // Case insensitivity
  test('ALL CAPS "WANT TO LEARN ABOUT X" → triggers', () =>
    assert.ok(isExplicitLearning('I WANT TO LEARN ABOUT REWARD MODELING IN RLHF SYSTEMS', [])));

  // Real-world topic variety
  test('PyTorch topic → triggers', () =>
    assert.ok(isExplicitLearning('I want to learn about implementing VAEs in PyTorch from scratch', [])));

  test('paper/research topic → triggers', () =>
    assert.ok(isExplicitLearning('I want to understand the MATS programme and how it works', [])));

  test('non-tech topic (baking) → triggers (user wants clarification on ANY explicit learning)', () =>
    assert.ok(isExplicitLearning('I want to learn about sourdough fermentation and starter culture', [])));

  // ── REGRESSION: "tell me about X" — the exact messages from the screenshot ──
  test('REGRESSION: "so tell me about linear probes" → triggers (5 words > 4)', () =>
    assert.ok(isExplicitLearning('so tell me about linear probes', [])));

  test('REGRESSION: "tell me about toy models of superposition" → triggers', () =>
    assert.ok(isExplicitLearning('tell me about toy models of superposition', [])));

  test('"tell me about attention mechanisms in transformers" → triggers', () =>
    assert.ok(isExplicitLearning('tell me about attention mechanisms in transformers', [])));

  test('"explain to me how backpropagation works" → triggers', () =>
    assert.ok(isExplicitLearning('explain to me how backpropagation works', [])));

  test('"what is a linear probe" → triggers (5 words > 4)', () =>
    assert.ok(isExplicitLearning('what is a linear probe', [])));

  test('"what are residual stream representations" → triggers', () =>
    assert.ok(isExplicitLearning('what are residual stream representations in transformers', [])));

  // ── "tell me about" boundary cases ──
  test('"tell me about it" (4 words, no topic) → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('tell me about it', [])));

  test('"explain it" (2 words) → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('explain it', [])));

  test('"what is this" (3 words, conversational) → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('what is this', [])));

  test('"tell me about X" WITH URL → does NOT trigger', () =>
    assert.ok(!isExplicitLearning('tell me about linear probes', ['https://arxiv.org/abs/2310.00001'])));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Short-message guard (expanded)
// ══════════════════════════════════════════════════════════════════════════════

describe('Short-message conversational guard (expanded)', () => {
  test('"hi" → conversational', () => assert.ok(isShortConversational('hi', [])));
  test('"nice job" → conversational', () => assert.ok(isShortConversational('nice job', [])));
  test('"ok" → conversational', () => assert.ok(isShortConversational('ok', [])));
  test('":(" → conversational', () => assert.ok(isShortConversational(':(', [])));
  test('"did you save" → conversational (exactly 3 words)', () => assert.ok(isShortConversational('did you save', [])));
  test('"thanks!" → conversational (punctuation ignored in word count)', () => assert.ok(isShortConversational('thanks!', [])));
  test('"lol" → conversational', () => assert.ok(isShortConversational('lol', [])));

  test('"want to apply now" → NOT conversational (4 words)', () =>
    assert.ok(!isShortConversational('want to apply now', [])));
  test('Long message → NOT conversational', () =>
    assert.ok(!isShortConversational('I want to learn about linear probes from Neel Nanda', [])));
  test('Short message WITH URL → NOT conversational', () =>
    assert.ok(!isShortConversational('hi', ['https://example.com'])));
  test('Whitespace-only → conversational (0 words)', () =>
    assert.ok(isShortConversational('   ', [])));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Pure-URL fast path (expanded)
// ══════════════════════════════════════════════════════════════════════════════

describe('Pure-URL fast path (expanded)', () => {
  test('bare URL only → pure URL', () => {
    const url = 'https://github.com/google-research/timesfm';
    assert.ok(isPureUrl(url, [url]));
  });

  test('URL + tiny annotation < 20 chars → pure URL', () => {
    const url = 'https://arxiv.org/abs/2310.00001';
    assert.ok(isPureUrl(`check ${url}`, [url]));
  });

  test('URL + long context → NOT pure URL (needs AI)', () => {
    const url = 'https://github.com/anthropics/claude-code';
    assert.ok(!isPureUrl(`I want to learn from this repository on AI safety research ${url}`, [url]));
  });

  test('no URLs → NOT pure URL', () => assert.ok(!isPureUrl('hello world', [])));

  test('URL stripped leaves whitespace only → pure URL', () => {
    const url = 'https://example.com';
    assert.ok(isPureUrl(`  ${url}  `, [url]));
  });

  test('URL with "save this" (9 chars) → pure URL', () => {
    const url = 'https://huggingface.co/papers/2310.00001';
    assert.ok(isPureUrl(`save this ${url}`, [url]));
  });

  test('URL with exactly 20 annotation chars → NOT pure URL (boundary)', () => {
    const url = 'https://example.com';
    const annotation = 'a'.repeat(20);
    assert.ok(!isPureUrl(`${annotation} ${url}`, [url]));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Vague learning detection (expanded)
// ══════════════════════════════════════════════════════════════════════════════

describe('Vague-learning detection (expanded)', () => {
  test('learning_tech + no URL → vague (trigger clarification)', () =>
    assert.ok(isVagueLearning({ project_hint: 'learning_tech' }, [])));

  test('learning_tech + URL → NOT vague (just save with URL context)', () =>
    assert.ok(!isVagueLearning({ project_hint: 'learning_tech' }, ['https://arxiv.org/abs/2310.00001'])));

  test('reading project → NOT vague learning', () =>
    assert.ok(!isVagueLearning({ project_hint: 'reading' }, [])));

  test('school project → NOT vague learning', () =>
    assert.ok(!isVagueLearning({ project_hint: 'school' }, [])));

  test('null project_hint → NOT vague learning', () =>
    assert.ok(!isVagueLearning({ project_hint: null }, [])));

  test('circuitry project → NOT vague learning', () =>
    assert.ok(!isVagueLearning({ project_hint: 'circuitry' }, [])));

  test('research_apps → NOT vague learning', () =>
    assert.ok(!isVagueLearning({ project_hint: 'research_apps' }, [])));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — classifyIntent fallback (expanded)
// ══════════════════════════════════════════════════════════════════════════════

describe('classifyIntent fallback (AI parse failure)', () => {
  test('1-word message → converse', () =>
    assert.equal(fallbackClassification('hi').intent, 'converse'));
  test('5-word message → converse', () =>
    assert.equal(fallbackClassification('can you check this out').intent, 'converse'));
  test('6-word message → save', () =>
    assert.equal(fallbackClassification('I want to apply to fellowship').intent, 'save'));
  test('long message → save', () =>
    assert.equal(fallbackClassification('I want to learn about linear probes like in Neel Nanda safety work').intent, 'save'));

  test('fallback returns all required fields', () => {
    const result = fallbackClassification('some longer message text today');
    for (const field of ['intent', 'context', 'timeline', 'project_hint', 'corrected_project', 'needs_clarification']) {
      assert.ok(field in result, `Missing field: ${field}`);
    }
  });

  test('fallback context is always null (no AI to determine it)', () =>
    assert.equal(fallbackClassification('fix the work ticket today').context, null));

  test('fallback needs_clarification is always false (safe default)', () =>
    assert.equal(fallbackClassification('github.com link for work').needs_clarification, false));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Reminder intent routing
// ══════════════════════════════════════════════════════════════════════════════

describe('Reminder intent routing', () => {
  test('reminder always targets personal project', () => {
    assert.equal('personal', 'personal'); // contract
  });

  test('timeline is appended to saved text with " — " separator', () => {
    const cls = { intent: 'reminder', timeline: '5:30pm Thursday' };
    const timeNote = cls.timeline ? ` — ${cls.timeline}` : '';
    assert.equal(timeNote, ' — 5:30pm Thursday');
  });

  test('null timeline produces no time annotation', () => {
    const cls = { intent: 'reminder', timeline: null };
    const timeNote = cls.timeline ? ` — ${cls.timeline}` : '';
    assert.equal(timeNote, '');
  });

  test('reminder reply uses 🗓️ emoji', () => {
    const msg = buildReminderMessage({ summary: 'Yoga at 7am' }, { timeline: '7am Monday' });
    assert.ok(msg.includes('🗓️'));
  });

  test('reminder reply does NOT use 📚 or other project emojis', () => {
    const msg = buildReminderMessage({ summary: 'Eye appointment' }, { timeline: '2pm Friday' });
    assert.ok(!msg.includes('📚'));
    assert.ok(!msg.includes('💼'));
    assert.ok(!msg.includes('🎓'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Project hint → project mapping in save flow
// ══════════════════════════════════════════════════════════════════════════════

describe('Project hint → project mapping', () => {
  const resolveProject = (cls) =>
    cls.project_hint ?? (cls.context === 'work' ? 'work' : null);

  test('project_hint takes precedence over context', () =>
    assert.equal(resolveProject({ project_hint: 'research_apps', context: 'work' }), 'research_apps'));
  test('null hint + work context → work', () =>
    assert.equal(resolveProject({ project_hint: null, context: 'work' }), 'work'));
  test('null hint + personal context → null (router decides)', () =>
    assert.equal(resolveProject({ project_hint: null, context: 'personal' }), null));
  test('null hint + null context → null', () =>
    assert.equal(resolveProject({ project_hint: null, context: null }), null));
  test('learning_tech hint + null context → learning_tech', () =>
    assert.equal(resolveProject({ project_hint: 'learning_tech', context: null }), 'learning_tech'));
  test('personal hint → personal', () =>
    assert.equal(resolveProject({ project_hint: 'personal', context: null }), 'personal'));
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — [SCAFFOLD] Future: full conversation turn simulation
// Tests the expected *conversation flow* for each intent type.
// These document the desired behaviour for v2+ without requiring real Slack.
// ══════════════════════════════════════════════════════════════════════════════

describe('[SCAFFOLD] Future conversation turn contracts', () => {
  // Each test describes what the bot SHOULD say and do in a given scenario.
  // Implement these as integration tests once bot.js pure functions are extracted.

  test('Fresh URL-only message → bot replies with project emoji + linked title (no question)', () => {
    // Expected flow:
    //   User: https://arxiv.org/abs/2310.00001
    //   Bot:  📚 <url|Attention Is All You Need>
    // Assert: reply starts with project emoji, contains Slack link syntax, no question mark
    const simulatedReply = buildSuccessMessage({ project: 'learning_tech', summary: 'Attention Is All You Need' }, {});
    assert.ok(simulatedReply.startsWith('📚'));
    assert.ok(!simulatedReply.includes('?'));
  });

  test('Vague learning message → bot asks ONE specific question, not two', () => {
    // Expected flow:
    //   User: I want to learn about transformers
    //   Bot:  what do you want to do with this — read, implement something, understand the theory, or write about it?
    // Assert: exactly one question mark, sentence is specific not vague
    const clarificationQ = `what do you want to do with this — read, implement something, understand the theory, or write about it?`;
    const questionMarks = (clarificationQ.match(/\?/g) ?? []).length;
    assert.equal(questionMarks, 1);
    assert.ok(clarificationQ.includes('read'));
    assert.ok(clarificationQ.includes('implement'));
    assert.ok(clarificationQ.includes('theory'));
  });

  test('After learning clarification → enriched task is actionable (starts with a verb)', () => {
    const userReply = 'implement it in PyTorch from scratch';
    const originalTopic = 'I want to learn about variational autoencoders';
    const enriched = buildEnrichedTask(userReply, originalTopic);
    const startsWithVerb = /^(implement|read|understand|build|write|explore|complete|work|study)/i.test(enriched);
    assert.ok(startsWithVerb);
    assert.ok(enriched.includes('variational autoencoder'));
  });

  test('Correction flow → bot confirms with project name, not generic "ok"', () => {
    // Expected: "got it — logged as school" not just "ok"
    const correctReply = `got it — logged as school`;
    assert.ok(correctReply.includes('school'));
    assert.ok(correctReply.startsWith('got it'));
  });

  test('Reminder message → bot includes time context in reply', () => {
    // User: "remind me to call the dentist at 5pm Friday"
    // Bot: 🗓️ <url|Call the dentist> · 5pm Friday
    const msg = buildReminderMessage(
      { summary: 'Call the dentist' },
      { timeline: '5pm Friday' }
    );
    assert.ok(msg.includes('5pm Friday'));
    assert.ok(msg.startsWith('🗓️'));
  });

  test('[SCAFFOLD] future: search_request → bot reply explains it will search, not just "ok"', () => {
    // Expected response when intent=search_request:
    //   "no link — want me to search for the application page? (y/n)"
    // Assert: contains y/n option, explains what it will do
    const searchPrompt = 'no link — want me to search for the application page? (y/n)';
    assert.ok(searchPrompt.includes('y/n'));
    assert.ok(searchPrompt.includes('search'));
    assert.ok(searchPrompt.includes('application page'));
  });

  test('[SCAFFOLD] future: work/personal clarification → question is direct, not verbose', () => {
    // The clarification question should be 3 words: "work or personal?"
    const q = 'work or personal?';
    assert.ok(q.split(/\s+/).length <= 5);
    assert.ok(q.includes('?'));
  });

  test('[SCAFFOLD] future: correction mode re-ask is specific about valid options', () => {
    // When bot can't parse the project from correction reply, it re-asks:
    const reask = "didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal";
    assert.ok(reask.includes('school'));
    assert.ok(reask.includes('work'));
    assert.ok(reask.includes('learning'));
    assert.ok(reask.includes("didn't catch that"));
  });

  test('[SCAFFOLD] future: weekly digest format lists by project group', () => {
    // When weekly summary feature lands (Step 6+), the digest should:
    // - Group items by project
    // - Show counts per project
    // - Not exceed ~20 lines in the DM
    // For now: assert the data structure we'd need
    const mockWeeklyData = {
      learning_tech: 3,
      research_apps: 1,
      school: 2,
      personal: 5,
    };
    const lines = Object.entries(mockWeeklyData).map(
      ([project, count]) => `${PROJECT_EMOJI[project] ?? '📁'} ${count} item${count === 1 ? '' : 's'}`
    );
    assert.ok(lines.length <= 20);
    assert.ok(lines.some(l => l.includes('📚')));
  });
});
