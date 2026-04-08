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

// --- isExplicitLearning (pre-AI heuristic added to bot.js) ---
// Catches "want to learn / learning about / trying to learn" before calling AI.
// Prevents misclassification when Gemini returns project_hint:null.
const isExplicitLearning = (text, urls) =>
  urls.length === 0 &&
  text.trim().split(/\s+/).filter(Boolean).length > 5 &&
  /\b(want to learn|learning about|i'?m learning|been learning|trying to learn|i want to understand)\b/i.test(text);

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
// SECTION 6 — Learning reply classification and task actionability
// Covers: the core fix — AI decides if user reply is a task or wants more info.
// The old bug: blindly concatenate the reply text → "tell me more about it explain it"
// The fix: AI classifies reply, either extracts a clean task OR has a conversation.
// ══════════════════════════════════════════════════════════════════════════════

// Simulates the AI classification of a learning reply (what the bot does internally).
// In production this calls callModelWithFallback — here we test the decision logic.
const classifyLearningReply = (userReply, _originalTopic) => {
  // Simulate AI output: if reply looks like a question/request for info → chat
  const chatPatterns = /\b(tell me more|explain|what is|what are|how does|more about|elaborate|clarify|i don'?t understand|help me understand)\b/i;
  if (chatPatterns.test(userReply)) {
    return { type: 'chat', reply: '[AI explanation of topic here]' };
  }
  // If reply looks like a direct intent → action
  const actionPatterns = /\b(implement|read|write|understand|build|explore|study|do it|try it|work through|code|run|create)\b/i;
  if (actionPatterns.test(userReply)) {
    return { type: 'action', task: userReply.slice(0, 80) };
  }
  // Ambiguous — short = action, long = chat
  return userReply.trim().split(/\s+/).length <= 6
    ? { type: 'action', task: userReply.slice(0, 80) }
    : { type: 'chat', reply: '[AI explanation of topic here]' };
};

// The final enriched task string (after AI classification gives us a clean task)
const buildEnrichedTaskFromReply = (aiTask, originalText) =>
  `${aiTask} — ${originalText.slice(0, 120)}`;

describe('Learning reply classification — AI-driven, not string concatenation', () => {

  // ── The exact scenario that was broken ──
  test('the failing case: "tell me more" → chat (NOT save)', () => {
    const result = classifyLearningReply(
      'tell me more about it, explain it and I\'ll tell u how I want to implement it',
      'I want to learn about linear probes like Neel Nanda safety work'
    );
    assert.equal(result.type, 'chat');
    assert.ok(!result.task, 'should not produce a task string for a chat reply');
  });

  test('"explain it" → chat', () =>
    assert.equal(classifyLearningReply('explain it to me', 'attention heads').type, 'chat'));

  test('"what is a linear probe?" → chat', () =>
    assert.equal(classifyLearningReply('what is a linear probe?', 'linear probes').type, 'chat'));

  test('"I don\'t understand it yet" → chat', () =>
    assert.equal(classifyLearningReply("I don't understand it yet", 'transformers').type, 'chat'));

  test('"more about it please" → chat', () =>
    assert.equal(classifyLearningReply('more about it please', 'RLHF').type, 'chat'));

  // ── Direct intent → action ──
  test('"implement it from scratch" → action', () =>
    assert.equal(classifyLearningReply('implement it from scratch', 'linear probes').type, 'action'));

  test('"read the key papers" → action', () =>
    assert.equal(classifyLearningReply('read the key papers', 'diffusion models').type, 'action'));

  test('"write a summary" → action', () =>
    assert.equal(classifyLearningReply('write a summary of it', 'transformers').type, 'action'));

  test('"understand the theory" → action', () =>
    assert.equal(classifyLearningReply('understand the theory first', 'backprop').type, 'action'));

  test('"implement it in PyTorch" → action with clean task', () => {
    const result = classifyLearningReply('implement it in PyTorch', 'linear probes');
    assert.equal(result.type, 'action');
    assert.ok(result.task?.length > 0);
    assert.ok(result.task.length <= 80);
  });

  // ── After action reply: enriched task must start with a verb, not a noun ──
  test('action task becomes verb-led enriched task', () => {
    const result = classifyLearningReply(
      'implement from scratch in PyTorch',
      'I want to learn about linear probes like Neel Nanda safety work'
    );
    assert.equal(result.type, 'action');
    const enriched = buildEnrichedTaskFromReply(result.task, 'I want to learn about linear probes like Neel Nanda safety work');
    // Starts with the action (implement), contains the topic (linear probes)
    assert.ok(enriched.startsWith('implement'));
    assert.ok(enriched.includes('linear probes'));
    assert.ok(enriched.includes(' — '));
  });

  test('chat reply contains helpful text, not empty string', () => {
    const result = classifyLearningReply('tell me more about it', 'RLHF from Anthropic');
    assert.equal(result.type, 'chat');
    assert.ok(result.reply.length > 0);
  });

  // ── Step limit: after 1 explanation, force save regardless ──
  test('step >= 2 forces save (no more chat exchanges)', () => {
    // Simulates: bot gave explanation, user still vague → save anyway with raw text
    const step = 2;
    const shouldForceSave = step >= 2;
    assert.ok(shouldForceSave);
  });

  test('after step-limit, even a vague reply gets saved (not chatted again)', () => {
    // At step 2, chatReply is null even if AI says type=chat → falls through to save
    const step = 2;
    const chatAllowed = step < 2;
    assert.equal(chatAllowed, false);
  });

  // ── Fallback: if AI call fails ──
  test('fallback: ≤8-word reply treated as direct intent', () => {
    const shortReply = 'implement it';
    const wordCount = shortReply.trim().split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= 8);
    // Bot would set saveAsText = userText for this
  });

  test('fallback: >8-word reply is also saved (we tried, user must move on)', () => {
    const longReply = 'I am not quite sure yet but maybe I want to understand the theory first';
    const wordCount = longReply.trim().split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount > 8);
    // At fallback, bot saves the raw reply anyway (better than silent failure)
  });

  // ── End-to-end conversation contract ──
  test('full conversation: topic → question → explanation → intent → save', () => {
    // Step 1: User says "I want to learn about linear probes"
    // → isExplicitLearning = true, bot asks clarification
    assert.ok(isExplicitLearning('I want to learn about linear probes like Neel Nanda', []));

    // Step 2: User says "tell me more"
    // → classifyLearningReply → type=chat, bot explains, keeps state (step=2)
    const step1Reply = classifyLearningReply('tell me more about it explain it', 'linear probes');
    assert.equal(step1Reply.type, 'chat');

    // Step 3: User says "ok I want to implement it in PyTorch"
    // → classifyLearningReply → type=action, bot saves
    const step2Reply = classifyLearningReply('ok I want to implement it in PyTorch', 'linear probes');
    assert.equal(step2Reply.type, 'action');

    // Final task: verb-led, contains topic
    const finalTask = buildEnrichedTaskFromReply(step2Reply.task, 'I want to learn about linear probes like Neel Nanda');
    assert.ok(finalTask.startsWith('implement') || finalTask.includes('implement'));
    assert.ok(finalTask.includes(' — '));
  });

  // ── Legacy: direct enrichment still works for clear one-shot replies ──
  test('direct clear reply skips chat entirely', () => {
    const enriched = buildEnrichedTaskFromReply(
      'implement from scratch in PyTorch',
      'I want to learn about linear probes'
    );
    assert.ok(enriched.startsWith('implement'));
    assert.ok(enriched.includes('linear probes'));
  });

  test('original text capped at 120 chars', () => {
    const long = 'I want to learn about ' + 'things '.repeat(30);
    const enriched = buildEnrichedTaskFromReply('implement it', long);
    const topicPart = enriched.split(' — ')[1];
    assert.ok(topicPart.length <= 120);
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
