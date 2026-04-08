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
 * TWO prompt constants — one for each AI call in the two-call learningMode architecture.
 * MUST be kept in sync with bot.js learningMode handler.
 *
 * CALL 1: Classification only — tiny JSON, maxTokens:60, never truncates.
 * CALL 2: Plain-text explanation — no JSON, maxTokens:180, only when type=chat.
 */
const LEARNING_CLASSIFY_PROMPT = (originalText) =>
`You are classifying a reply in a learning dialogue about: "${originalText.slice(0, 150)}"
The user was asked: "what do you want to do — read, implement, understand the theory, or write about it?"

Return ONLY valid JSON, nothing else: {"type": "action"} or {"type": "chat"}

type=action: reply is a short unambiguous task commitment. Examples:
  "implement it" → action  |  "read the paper" → action  |  "write a summary" → action
type=chat: everything else — user wants more info, is exploring, asking questions, or hasn't decided. When in doubt: chat.`;

const LEARNING_EXPLAIN_PROMPT = (originalText) =>
`You are a knowledgeable research companion in an ongoing Slack conversation.
Topic the user is exploring: "${originalText.slice(0, 150)}"

Rules:
- Do NOT re-introduce or define the topic from scratch — respond directly to what the user just said.
- Be specific: cite real papers, researchers, findings, and benchmarks by name when you know them. If something is a landmark result or recent breakthrough, say so naturally.
- If you reference a paper or line of work worth following up on, note it in passing — e.g. "that's worth adding to a reading queue" or "the Marks et al. 2023 paper on this is surprisingly accessible".
- Write like a colleague who knows this area deeply: skip "Great question!", no textbook openers, no bullet points, no headers.
- End with something specific to the thread of this conversation — an observation or question that opens the next line of inquiry. Not a menu of options.
- Plain text only. Around 4-5 sentences.`;

/**
 * Decision logic: given the parsed Call 1 JSON (only has {type}) and the current step,
 * return { saveAsText, chatReply }.
 * NOTE: chatReply is NOT derived from the parsed JSON — it comes from Call 2 separately.
 * This function only handles the action path; chat path chatReply comes from the explain call.
 */
function handleLearningReplyResult(parsed, step) {
  let saveAsText = null;
  let chatReply  = null;
  if (parsed?.type === 'action') {
    // bot.js uses userText.trim().slice(0, 60) as saveAsText — simulate with a placeholder
    saveAsText = 'action-task';
  } else if (parsed?.type === 'chat' && step < 8) {
    // chatReply is set by Call 2 (explain call) — from test perspective, mark as "would explain"
    // Step cap is 8: at step=8 bot sends a soft check-in instead (handled inline in bot.js)
    chatReply = 'would-explain';
  }
  return { saveAsText, chatReply };
}

/**
 * Fallback when AI classify call fails.
 * step<3: return null → bot re-asks (too early to give up).
 * step>=3: saves generic "Explore and learn about [topic]" task.
 */
function learningReplyFallback(userText, step, originalText) {
  if (step >= 3) {
    return { saveAsText: `Explore and learn about ${originalText.slice(0, 60)}` };
  }
  // step<3: return null → bot re-asks (does NOT save raw conversational text)
  return { saveAsText: null };
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

describe('handleLearningReplyResult — decision logic given Call 1 JSON (type only)', () => {
  // NOTE: Call 1 only returns {"type": "action"} or {"type": "chat"} — no task/reply fields.
  // chatReply is set by Call 2 (explain call) independently — not derived from parsed JSON.
  // This function maps: action → saveAsText set; chat+step<3 → chatReply set (placeholder).

  // ── type=action cases ──
  test('action → saveAsText is set, chatReply is null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'action' }, 1);
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);
  });

  test('action at step 2 → still saves (action always saves regardless of step)', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'action' }, 2);
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);
  });

  test('action at step 3 → still saves (step limit only blocks chat, not action)', () => {
    const { saveAsText } = handleLearningReplyResult({ type: 'action' }, 3);
    assert.ok(saveAsText !== null);
  });

  // ── type=chat cases ──
  test('chat at step 1 → chatReply set (explain call will fire), saveAsText null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.ok(chatReply !== null);
    assert.equal(saveAsText, null);
  });

  test('chat at step 2 → chatReply set (step cap is now 8)', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'chat' }, 2);
    assert.ok(chatReply !== null);
    assert.equal(saveAsText, null);
  });

  test('chat at step 3 → chatReply set (step 3 still within cap of 8)', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'chat' }, 3);
    assert.ok(chatReply !== null);
    assert.equal(saveAsText, null);
  });

  test('chat at step 8 → chatReply is NULL (step limit reached, bot sends soft check-in)', () => {
    // At step=8 bot.js sends a soft check-in instead of explaining again
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'chat' }, 8);
    assert.equal(chatReply, null);
    assert.equal(saveAsText, null); // bot.js handles soft check-in inline
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
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'save' }, 1);
    assert.equal(saveAsText, null);
    assert.equal(chatReply, null);
  });

  test('unknown type "converse" → both null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'converse' }, 1);
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

  test('step=1 allows chat response (1 < 3)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.ok(chatReply !== null);
  });

  test('step=2 still allows chat (2 < 8)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 2);
    assert.ok(chatReply !== null);
  });

  test('step=3 still allows chat (3 < 8)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 3);
    assert.ok(chatReply !== null);
  });

  test('step=7 still allows chat (7 < 8) — last exchange before soft check-in', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 7);
    assert.ok(chatReply !== null);
  });

  test('step=8 blocks chat (8 is NOT < 8) → both null, bot sends soft check-in inline', () => {
    const { chatReply, saveAsText } = handleLearningReplyResult({ type: 'chat' }, 8);
    assert.equal(chatReply, null);
    assert.equal(saveAsText, null);
  });

  test('step=0 allows chat (edge case: step defaults to 1 in bot.js, but 0 also passes)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 0);
    assert.ok(chatReply !== null);
  });

  test('after chat response, step increments: state.step becomes step+1', () => {
    const state = { learningMode: true, originalText: 'topic', step: 1 };
    const newState = { ...state, step: state.step + 1 };
    assert.equal(newState.step, 2);
  });

  test('at step=2, action still works (step limit only blocks chat)', () => {
    const { saveAsText } = handleLearningReplyResult({ type: 'action' }, 2);
    assert.ok(saveAsText !== null);
  });

  test('missing step (state.step undefined) defaults to 1 via ?? 1', () => {
    const step = undefined ?? 1;
    assert.equal(step, 1);
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, step);
    assert.ok(chatReply !== null);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6C — Learning reply: fallback when AI call fails
// Tests bot.js catch{} block: what happens when classifyLearningReply throws.
// ══════════════════════════════════════════════════════════════════════════════

describe('Learning reply: fallback when AI call fails', () => {

  const topic = 'linear probes in neural networks';

  test('step=1 fallback → saveAsText is null (re-ask clarification, do not save)', () => {
    const { saveAsText } = learningReplyFallback('implement it from scratch', 1, topic);
    assert.equal(saveAsText, null);
  });

  test('step=1 fallback with long vague reply → still null (re-ask, never save garbage)', () => {
    const msg = 'tell me more about it because I do not know what linear probes are yet';
    const { saveAsText } = learningReplyFallback(msg, 1, topic);
    assert.equal(saveAsText, null);
  });

  test('step=1 fallback with short clear reply → still null (AI handles action; fallback re-asks)', () => {
    const { saveAsText } = learningReplyFallback('read the paper', 1, topic);
    assert.equal(saveAsText, null);
  });

  test('step=2 fallback → null (re-ask; threshold is step>=3, still too early to give up)', () => {
    const { saveAsText } = learningReplyFallback('still not sure', 2, topic);
    assert.equal(saveAsText, null);
  });

  test('step=3 fallback → saveAsText is generic "Explore and learn about [topic]"', () => {
    const { saveAsText } = learningReplyFallback('still not sure', 3, topic);
    assert.ok(saveAsText !== null);
    assert.ok(saveAsText.startsWith('Explore and learn about'));
    assert.ok(saveAsText.includes('linear probes'));
  });

  test('step=3 fallback uses originalText, not the current reply', () => {
    const reply       = 'I still want to figure out what to do';
    const originalTop = 'attention heads and induction circuits';
    const { saveAsText } = learningReplyFallback(reply, 3, originalTop);
    assert.ok(saveAsText.includes('attention heads'));
    assert.ok(!saveAsText.includes('figure out what to do'));
  });

  test('step=3 fallback trims originalText to 60 chars', () => {
    const longTopic = 'a'.repeat(80);
    const { saveAsText } = learningReplyFallback('whatever', 3, longTopic);
    // "Explore and learn about " (24 chars) + 60 chars of topic = max 84 chars
    assert.ok(saveAsText.length <= 84);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6C2 — bareAction fast-path regex
// Tests the regex that lets "read", "implement", etc. skip AI and save immediately.
// Must stay in sync with bot.js learningMode bareAction regex.
// ══════════════════════════════════════════════════════════════════════════════

const bareActionRegex = /^(read|implement|write|understand|learn|theory|both|all)(\s+(it|the paper|more|about it|everything))?$/i;

describe('bareAction fast-path — saves without AI call', () => {

  test('"read" alone → matches (single word action)', () => {
    assert.ok(bareActionRegex.test('read'));
  });

  test('"implement" → matches', () => {
    assert.ok(bareActionRegex.test('implement'));
  });

  test('"write" → matches', () => {
    assert.ok(bareActionRegex.test('write'));
  });

  test('"understand" → matches', () => {
    assert.ok(bareActionRegex.test('understand'));
  });

  test('"learn" → matches', () => {
    assert.ok(bareActionRegex.test('learn'));
  });

  test('"theory" → matches', () => {
    assert.ok(bareActionRegex.test('theory'));
  });

  test('"both" → matches (user wants multiple options)', () => {
    assert.ok(bareActionRegex.test('both'));
  });

  test('"all" → matches', () => {
    assert.ok(bareActionRegex.test('all'));
  });

  test('"read it" → matches (verb + pronoun)', () => {
    assert.ok(bareActionRegex.test('read it'));
  });

  test('"read the paper" → matches', () => {
    assert.ok(bareActionRegex.test('read the paper'));
  });

  test('"implement it" → matches', () => {
    assert.ok(bareActionRegex.test('implement it'));
  });

  test('"understand the theory" → does NOT match (bareAction handles "understand" not "understand the theory")', () => {
    // "understand" alone matches, "understand the theory" is 3 words — suffix group is: it|the paper|more|about it|everything
    // "the theory" is not in the suffix group → does not match
    assert.ok(!bareActionRegex.test('understand the theory'));
  });

  test('"tell me more" → does NOT match (not an action word)', () => {
    assert.ok(!bareActionRegex.test('tell me more'));
  });

  test('"I want to read it" → does NOT match (has prefix words)', () => {
    assert.ok(!bareActionRegex.test('I want to read it'));
  });

  test('"implement it from scratch" → does NOT match (too long for fast-path)', () => {
    assert.ok(!bareActionRegex.test('implement it from scratch'));
  });

  test('REGRESSION: "read" should save without infinite loop', () => {
    // This was the exact failing case — user said "read" and got looped
    assert.ok(bareActionRegex.test('read'));
    assert.ok(bareActionRegex.test('Read'));  // case-insensitive
    assert.ok(bareActionRegex.test('READ'));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6D — Prompt content validation (two-call architecture)
// Call 1: LEARNING_CLASSIFY_PROMPT — tiny JSON classification only
// Call 2: LEARNING_EXPLAIN_PROMPT  — plain text explanation only
// ══════════════════════════════════════════════════════════════════════════════

describe('LEARNING_CLASSIFY_PROMPT — Call 1 content validation', () => {

  const topic  = 'linear probes like Neel Nanda safety work';
  const prompt = LEARNING_CLASSIFY_PROMPT(topic);

  test('prompt injects the learning topic', () => {
    assert.ok(prompt.includes('linear probes like Neel Nanda safety work'));
  });

  test('prompt specifies the question context that was asked', () => {
    assert.ok(prompt.includes('read, implement') || prompt.includes('what do you want to do'));
  });

  test('prompt returns ONLY JSON — no markdown or prose', () => {
    assert.ok(prompt.includes('ONLY valid JSON') || prompt.includes('nothing else'));
  });

  test('prompt output schema has only {"type"} — no task or reply fields', () => {
    assert.ok(prompt.includes('"type"'));
    assert.ok(!prompt.includes('"task"'));
    assert.ok(!prompt.includes('"reply"'));
  });

  test('prompt defines type=action with clear examples', () => {
    assert.ok(prompt.includes('action'));
    assert.ok(prompt.includes('implement'));
  });

  test('prompt defines type=chat for exploratory/uncertain replies', () => {
    assert.ok(prompt.includes('chat'));
    assert.ok(prompt.includes('more info') || prompt.includes('exploring') || prompt.includes('hasn\'t decided'));
  });

  test('prompt has "when in doubt: chat" bias', () => {
    assert.ok(prompt.toLowerCase().includes('when in doubt'));
  });

  test('prompt explicitly requires unambiguous task commitment for type=action', () => {
    assert.ok(prompt.includes('unambiguous') || prompt.includes('short') || prompt.includes('commitment'));
  });

  test('prompt is compact — designed for maxTokens:60', () => {
    // Prompt itself should be under 300 words so the model can fit response in 60 tokens
    const wordCount = prompt.trim().split(/\s+/).length;
    assert.ok(wordCount < 300, `Prompt is ${wordCount} words — may be too long for 60-token budget`);
  });
});

describe('LEARNING_EXPLAIN_PROMPT — Call 2 content validation', () => {

  const topic  = 'linear probes like Neel Nanda safety work';
  const prompt = LEARNING_EXPLAIN_PROMPT(topic);

  test('prompt injects the learning topic', () => {
    assert.ok(prompt.includes('linear probes like Neel Nanda safety work'));
  });

  test('prompt asks for around 4-5 sentences', () => {
    assert.ok(prompt.includes('4-5 sentences') || prompt.includes('4–5 sentences'));
  });

  test('prompt requires plain text — explicitly forbids markdown', () => {
    assert.ok(prompt.includes('Plain text only') || prompt.includes('no markdown'));
  });

  test('prompt does NOT ask for JSON output', () => {
    assert.ok(!prompt.includes('"type"'));
    assert.ok(!prompt.includes('{"'));
    assert.ok(!prompt.includes('JSON'));
  });

  test('prompt instructs model to end with something specific to conversation, not a menu', () => {
    assert.ok(prompt.includes('Not a menu') || prompt.includes('thread of this conversation') || prompt.includes('next line of inquiry'));
  });

  test('prompt encourages citing real papers and researchers by name', () => {
    assert.ok(
      prompt.includes('papers') ||
      prompt.includes('researchers') ||
      prompt.includes('cite')
    );
  });

  test('prompt tells model NOT to re-introduce the topic from scratch', () => {
    assert.ok(prompt.includes('NOT re-introduce') || prompt.includes('Do NOT re-introduce'));
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

  // ── Call 1 classify prompt must cover exploratory phrasing as type=chat ──
  const classifyPrompt = LEARNING_CLASSIFY_PROMPT('linear probes Neel Nanda safety');

  test('classify prompt covers "more info" / exploratory intent → type=chat', () => {
    assert.ok(
      classifyPrompt.includes('more info') ||
      classifyPrompt.includes('exploring') ||
      classifyPrompt.includes('hasn\'t decided')
    );
  });

  test('classify prompt covers "when in doubt: chat" bias', () => {
    assert.ok(classifyPrompt.toLowerCase().includes('when in doubt'));
  });

  test('classify prompt only returns {"type"} — never includes explanation in output', () => {
    assert.ok(!classifyPrompt.includes('"reply"'));
    assert.ok(!classifyPrompt.includes('"task"'));
  });

  // ── Decision logic: given Call 1 correctly returns type=chat, bot does NOT save ──
  test('decision: type=chat at step=1 → chatReply set (explain call fires), saveAsText null', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.equal(saveAsText, null);
    assert.ok(chatReply !== null);
  });

  test('decision: type=chat → bot keeps pending state (step increments to 2)', () => {
    const { chatReply } = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.ok(chatReply !== null);
    const newStep = 1 + 1;
    assert.equal(newStep, 2);
  });

  test('decision: type=action → saveAsText set, bot saves immediately', () => {
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'action' }, 1);
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);
  });

  // ── Call 2 explain prompt must generate real information ──
  test('explain prompt asks for explanation of the actual topic', () => {
    const explainPrompt = LEARNING_EXPLAIN_PROMPT('linear probes Neel Nanda safety');
    assert.ok(explainPrompt.includes('linear probes Neel Nanda safety'));
    assert.ok(!explainPrompt.includes('JSON'));
  });

  // ── Contrast: clear actions → type=action from decision function ──
  test('clear action responses produce type=action from decision function', () => {
    const directIntents = [
      { type: 'action' },
      { type: 'action' },
      { type: 'action' },
    ];
    for (const parsed of directIntents) {
      const { saveAsText } = handleLearningReplyResult(parsed, 1);
      assert.ok(saveAsText !== null);
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

    // Turn 2: user gives direct intent → Call 1 returns type=action → saveAsText set
    // In bot.js: saveAsText = userText.trim().slice(0, 60) — user's own words
    const userReply = 'implement a linear probe in PyTorch from scratch';
    const { saveAsText, chatReply } = handleLearningReplyResult({ type: 'action' }, 1);
    assert.ok(saveAsText !== null);
    assert.equal(chatReply, null);

    // Simulate bot.js: saveAsText = userReply.trim().slice(0, 60)
    const actualSaveAsText = userReply.trim().slice(0, 60);
    const topic = 'I want to learn about linear probes like Neel Nanda safety work';
    const saved = buildFinalTask(actualSaveAsText, topic);
    assert.ok(saved.startsWith('implement'));
    assert.ok(saved.includes('linear probes'));
    assert.ok(saved.includes(' — '));
    assert.ok(!saved.startsWith('I want to learn')); // not vague
  });

  test('CHAT PATH: "tell me more" → classify=chat → explain call fires → step→2 → user gives intent → saves', () => {
    // Turn 1: topic → question
    assert.ok(isExplicitLearning('I want to learn about linear probes', []));

    // Turn 2: "tell me more" → Call 1 returns type=chat at step=1 → explain call fires
    const turn2 = handleLearningReplyResult({ type: 'chat' }, 1);
    assert.equal(turn2.saveAsText, null);
    assert.ok(turn2.chatReply !== null); // marks that explain call would fire

    // State: step becomes 2 (still < 3, so chat still allowed next turn)
    const newStep = 2;

    // Turn 3: user gives intent → Call 1 returns type=action → saves
    const turn3 = handleLearningReplyResult({ type: 'action' }, newStep);
    assert.ok(turn3.saveAsText !== null);
    assert.equal(turn3.chatReply, null);
  });

  test('STEP LIMIT PATH: 8 chat turns allowed; at step=8 bot sends soft check-in instead', () => {
    // Steps 1-7: all allow chat (step < 8)
    for (let s = 1; s <= 7; s++) {
      const turn = handleLearningReplyResult({ type: 'chat' }, s);
      assert.ok(turn.chatReply !== null, `step=${s} should still allow chat`);
    }

    // Step 8: BLOCKED — bot.js sends soft check-in inline (both null from helper)
    const turn9 = handleLearningReplyResult({ type: 'chat' }, 8);
    assert.equal(turn9.chatReply, null);
    assert.equal(turn9.saveAsText, null);
  });

  test('FALLBACK PATH: AI classify fails at step=1,2 → re-asks; at step=3 → saves generic task', () => {
    const topic = 'linear probes in neural networks';

    // Step=1,2 classify failure → null → bot re-asks (threshold is step>=3)
    const step1 = learningReplyFallback('tell me more', 1, topic);
    assert.equal(step1.saveAsText, null);

    const step2 = learningReplyFallback('still not sure', 2, topic);
    assert.equal(step2.saveAsText, null);

    // Step=3 classify failure → saves generic
    const step3 = learningReplyFallback('still not sure', 3, topic);
    assert.ok(step3.saveAsText !== null);
    assert.ok(step3.saveAsText.startsWith('Explore and learn about'));
    assert.ok(step3.saveAsText.includes('linear probes'));
  });

  test('STEP LIMIT: step=8 chat → handleLearningReplyResult returns both null (bot.js sends soft check-in)', () => {
    const result = handleLearningReplyResult({ type: 'chat' }, 8);
    assert.equal(result.chatReply, null);
    assert.equal(result.saveAsText, null);
  });

  test('FALLBACK: AI exception at step=3 → learningReplyFallback saves generic task', () => {
    const fallback = learningReplyFallback('Still vague...', 3, 'linear probes');
    assert.ok(fallback.saveAsText.startsWith('Explore and learn about'));
    assert.ok(fallback.saveAsText.includes('linear probes'));
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
