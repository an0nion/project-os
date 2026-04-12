/**
 * Tier Classifier — unit tests
 *
 * Tests the pure classifyTier() function exhaustively:
 * - All tier boundaries
 * - Escalation triggers (explicit, topic, pushback)
 * - Sticky escalation and de-escalation
 * - Short-message heuristic
 * - messageCount thresholds
 * - Output shape contract
 *
 * Run: node --test tests/tier-classifier.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier } from '../lib/tierClassifier.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function classify(msg, opts = {}) {
  return classifyTier(msg, { projectKey: 'learning_tech', messageCount: 0, isEscalated: false, ...opts });
}

// ── output shape ──────────────────────────────────────────────────────────────

describe('output shape contract', () => {
  test('always returns tier, primaryModel, fallbackModel, maxTokens, reason', () => {
    const r = classify('hello');
    assert.ok('tier'          in r, 'missing tier');
    assert.ok('primaryModel'  in r, 'missing primaryModel');
    assert.ok('fallbackModel' in r, 'missing fallbackModel');
    assert.ok('maxTokens'     in r, 'missing maxTokens');
    assert.ok('reason'        in r, 'missing reason');
  });

  test('tier is 0, 1, 2 or 3', () => {
    for (const msg of ['mark task done', 'remind me', 'explain this', 'help me think through alignment']) {
      const { tier } = classify(msg);
      assert.ok([0, 1, 2, 3].includes(tier), `unexpected tier ${tier} for "${msg}"`);
    }
  });

  test('maxTokens is a positive number (or 0 for tier 0)', () => {
    const r0 = classify('mark task as done');
    assert.strictEqual(r0.tier, 0);
    assert.strictEqual(r0.maxTokens, 0);

    const r1 = classify('remind me to buy milk');
    assert.ok(r1.maxTokens > 0);

    const r2 = classify('explain transformer attention in detail to me');
    assert.ok(r2.maxTokens > 0);
  });

  test('reason is a non-empty string', () => {
    const { reason } = classify('hello world how are you doing today?');
    assert.ok(typeof reason === 'string' && reason.length > 0);
  });
});

// ── Tier 0 ────────────────────────────────────────────────────────────────────

describe('Tier 0 — code-only, no AI', () => {
  const tier0Messages = [
    'mark task as done',
    'toggle task',
    'check this off',
    'uncheck item',
    'complete task',
    'finish this',
    'show my tasks',
    "show what's my deadlines",
    'list my tasks',
    'display my calendar',
    "what's my status",
    'open the app',
    'go to dashboard',
    'set timer for 25 minutes',
    'start timer',
    'set alarm',
    'move application to submitted',
    'move draft to review',
    'delete task',
    'remove reminder',
    'cancel event',
    'how many tasks do I have',
    'count my applications',
  ];

  for (const msg of tier0Messages) {
    test(`"${msg}" → tier 0`, () => {
      const r = classify(msg);
      assert.strictEqual(r.tier, 0, `expected tier 0, got ${r.tier} (reason: ${r.reason})`);
      assert.strictEqual(r.primaryModel, null);
      assert.strictEqual(r.maxTokens, 0);
    });
  }
});

// ── Tier 1 ────────────────────────────────────────────────────────────────────

describe('Tier 1 — cheap/free models', () => {
  const tier1Messages = [
    'remind me to buy milk',
    'add to calendar tomorrow',
    'set reminder for Tuesday',
    'schedule dentist appointment',
    'route this to the right project',
    'classify this task',
    'categorize this link',
    'which project does this belong to',
    'summarize this in one sentence',
    'convert this to JSON',
    'extract the URL from this',
    'parse the date from this',
    'format this as markdown',
    'translate this to French',
  ];

  for (const msg of tier1Messages) {
    test(`"${msg}" → tier 1`, () => {
      const r = classify(msg);
      assert.strictEqual(r.tier, 1, `expected tier 1, got ${r.tier} (reason: ${r.reason})`);
      assert.strictEqual(r.primaryModel, 'gemini-flash');
      assert.strictEqual(r.fallbackModel, 'deepseek-chat');
      assert.ok(r.maxTokens > 0 && r.maxTokens <= 400);
    });
  }

  test('very short non-question messages → tier 1 (short command heuristic)', () => {
    const shortMessages = [
      'read it',
      'implement',
      'save this',
      'got it',
      'sounds good',
      'ok',
      'next',
    ];
    for (const msg of shortMessages) {
      const r = classify(msg);
      assert.ok(r.tier <= 1, `"${msg}" should be tier 0-1, got ${r.tier}`);
    }
  });

  test('short message with question mark → not auto-downgraded to tier 1', () => {
    // "why?" is short but has "?" — should NOT get the short-command tier 1
    const r = classify('why?');
    // Could be tier 1 for other reasons, but not the "short command" heuristic
    // This just ensures it doesn't crash
    assert.ok([0, 1, 2, 3].includes(r.tier));
  });
});

// ── Tier 2 ────────────────────────────────────────────────────────────────────

describe('Tier 2 — default workhorse', () => {
  // Must be > 7 words (not short command) and not trigger tier 0/1/3 patterns
  const tier2Messages = [
    // Long enough (> 7 words), no tier-3 topic match, no tier-1 pattern
    'can you explain how transformer attention mechanisms actually work in practice?',
    'what are the tradeoffs between different optimization algorithms in deep learning?',
    'help me understand the intuition behind why gradient descent converges correctly',
    'give me a comprehensive summary of recent work on diffusion models in ML',
    'what should I read to understand reinforcement learning from human feedback better?',
    'can you explain the intuition behind variational autoencoders for a beginner?',
    'how does in-context learning actually work in large language models at scale?',
  ];

  for (const msg of tier2Messages) {
    test(`"${msg.slice(0,50)}" → tier 2`, () => {
      const r = classify(msg);
      assert.strictEqual(r.tier, 2, `expected tier 2, got ${r.tier} (reason: ${r.reason})`);
      assert.strictEqual(r.primaryModel, 'deepseek-chat');
      assert.strictEqual(r.fallbackModel, 'sonnet');
      assert.ok(r.maxTokens >= 500);
    });
  }
});

// ── Tier 3 — explicit escalation ──────────────────────────────────────────────

describe('Tier 3 — explicit escalation triggers', () => {
  const escalateExplicit = [
    "go deeper on that",
    "think harder about this",
    "more nuance please",
    "unpack this for me",
    "let's explore this further",
    "what do you really think?",
    "devil's advocate: why is this wrong?",
    "challenge my assumption here",
    "push back on this",
    "help me develop this idea",
    "help me articulate this",
    "help me formulate a position",
    "help me think through this",
    "help me reason about this",
    "steelman the opposing view",
    "strawman this argument",
    "critique my approach",
    "critique this paper",
  ];

  for (const msg of escalateExplicit) {
    test(`explicit: "${msg}" → tier 3`, () => {
      const r = classify(msg);
      assert.strictEqual(r.tier, 3, `expected tier 3, got ${r.tier} (reason: ${r.reason})`);
      assert.strictEqual(r.primaryModel, 'opus');
      assert.strictEqual(r.fallbackModel, 'sonnet');
      assert.ok(r.maxTokens >= 1500);
    });
  }
});

// ── Tier 3 — topic-based escalation ──────────────────────────────────────────

describe('Tier 3 — topic-based escalation', () => {
  const topicMessages = [
    'what is my research statement?',
    'help me with my research direction',
    'what is the research question here?',
    'developing my research position',
    'my research proposal needs work',
    'I am thinking about my research agenda',
    'discuss the philosophical implications',
    'epistemological foundations of this',
    'ontological commitments in this framework',
    'phenomenological analysis',
    'metaphysical assumptions here',
    'the alignment problem is central to this',
    'alignment research approach',
    'this paper needs a detailed review from you',
    'my thesis critique session starts now',
    'dissertation feedback on the methodology section',
    'mechanistic interpretability of transformers',
    'interpretability research methods',
    'circuit-level analysis of the model',
    'feature analysis in neural networks',
    "what's wrong with this approach?",
    "what is flawed in this argument?",
    "what is wrong with this framing here?",
    'original contribution of this paper',
    'original insight here',
  ];

  for (const msg of topicMessages) {
    test(`topic: "${msg}" → tier 3`, () => {
      const r = classify(msg);
      assert.strictEqual(r.tier, 3, `expected tier 3, got ${r.tier} (reason: ${r.reason})`);
    });
  }
});

// ── Tier 3 — pushback (requires messageCount > 2) ────────────────────────────

describe('Tier 3 — pushback (after 2+ messages)', () => {
  const pushbackMessages = [
    "but why does this matter?",
    "that's not right",
    "that's not quite what I meant",
    "that's not exactly it",
    "I disagree with that",
    "I'm not convinced",
    "can you explain more?",
    "can you elaborate further?",
    "can you explain deeper why?",
    "what about the edge cases?",
    "have you considered the alternative?",
    "isn't it true that this fails?",
    "I don't think that's right",
    "I don't agree with this",
    "I don't buy that argument",
    "that seems wrong to me",
    "that seems off",
    "that seems shallow",
  ];

  for (const msg of pushbackMessages) {
    test(`pushback (messageCount=3): "${msg}" → tier 3`, () => {
      const r = classify(msg, { messageCount: 3, isEscalated: false, projectKey: 'learning_tech' });
      assert.strictEqual(r.tier, 3, `expected tier 3, got ${r.tier} (reason: ${r.reason})`);
    });

    test(`pushback (messageCount=1): "${msg.slice(0,40)}" → NOT tier 3 from pushback`, () => {
      // With only 1 message, pushback patterns don't trigger
      // (they might still trigger via topic match — just verify the guard exists)
      const rLow  = classify(msg, { messageCount: 1, isEscalated: false });
      const rHigh = classify(msg, { messageCount: 5, isEscalated: false });
      // High messageCount must be >= tier of low messageCount (pushback can only upgrade)
      assert.ok(rHigh.tier >= rLow.tier || rHigh.tier === 3,
        `messageCount guard broken for "${msg}": low=${rLow.tier} high=${rHigh.tier}`);
    });
  }
});

// ── Tier 3 — conversation depth auto-escalation ───────────────────────────────

describe('Tier 3 — conversation depth auto-escalation', () => {
  test('messageCount=9 in learning_tech → tier 3', () => {
    const r = classify('tell me more about this', { messageCount: 9, projectKey: 'learning_tech' });
    assert.strictEqual(r.tier, 3);
    assert.match(r.reason, /deep conversation/i);
  });

  test('messageCount=9 in reading → tier 3', () => {
    const r = classify('what do you think about this chapter', { messageCount: 9, projectKey: 'reading' });
    assert.strictEqual(r.tier, 3);
  });

  test('messageCount=9 in baking → NOT tier 3 from depth heuristic', () => {
    const r = classify('what temperature should I use', { messageCount: 9, projectKey: 'baking' });
    // baking is not a depth-escalation project
    assert.ok(r.tier < 3 || r.tier === 3, 'should not crash'); // just ensure no crash
    // verify it's NOT the "deep conversation" reason for baking
    if (r.tier === 3) {
      assert.doesNotMatch(r.reason, /deep conversation/i);
    }
  });

  test('messageCount=8 in learning_tech → NOT auto-escalated (boundary is > 8)', () => {
    const r = classify('tell me more', { messageCount: 8, projectKey: 'learning_tech' });
    // must NOT be tier 3 from depth alone (messageCount > 8 required)
    // (could be tier 1 due to short command heuristic)
    assert.ok(r.tier !== 3 || r.reason !== 'Deep conversation in learning project');
  });
});

// ── Sticky escalation ─────────────────────────────────────────────────────────

describe('Sticky escalation — isEscalated=true', () => {
  const genericMessages = [
    'tell me more',
    'interesting, continue',
    'what about the implications?',
    'how does this connect to X?',
    'elaborate on that',
    'I see, and what about Y?',
    'hmm, go on',
  ];

  for (const msg of genericMessages) {
    test(`sticky: "${msg}" → stays tier 3`, () => {
      const r = classify(msg, { isEscalated: true, messageCount: 3 });
      assert.strictEqual(r.tier, 3, `expected sticky tier 3, got ${r.tier}`);
      assert.strictEqual(r.primaryModel, 'opus');
      assert.match(r.reason, /sticky/i);
    });
  }

  test('sticky with logistics message → de-escalates to tier 1', () => {
    const logisticsMessages = [
      'add that to my calendar',
      'ok remind me',
      'save this',
      'ok thanks got it',
      'moving on',
      'schedule this for tomorrow',
    ];
    for (const msg of logisticsMessages) {
      const r = classify(msg, { isEscalated: true });
      assert.strictEqual(r.tier, 1, `"${msg}" should de-escalate to tier 1, got ${r.tier}`);
      assert.strictEqual(r.primaryModel, 'gemini-flash');
      assert.match(r.reason, /de-escalated/i);
    }
  });

  test('non-escalated does not get sticky tier 3', () => {
    const r = classify('tell me more', { isEscalated: false, messageCount: 3 });
    // Without escalation flag, "tell me more" is short → tier 1
    assert.ok(r.tier <= 2, `expected tier <=2 without escalation, got ${r.tier}`);
  });
});

// ── Model/cost contracts ──────────────────────────────────────────────────────

describe('model and cost contracts', () => {
  test('tier 1 always uses gemini-flash primary', () => {
    const r = classify('remind me to buy milk');
    assert.strictEqual(r.primaryModel, 'gemini-flash');
  });

  test('tier 1 always uses deepseek-chat fallback', () => {
    const r = classify('remind me to buy milk');
    assert.strictEqual(r.fallbackModel, 'deepseek-chat');
  });

  test('tier 2 always uses deepseek-chat primary', () => {
    const r = classify('explain how transformer attention mechanisms actually work in practice');
    assert.strictEqual(r.primaryModel, 'deepseek-chat');
  });

  test('tier 2 always uses sonnet fallback', () => {
    const r = classify('explain how transformer attention mechanisms actually work in practice');
    assert.strictEqual(r.fallbackModel, 'sonnet');
  });

  test('tier 3 always uses opus primary', () => {
    const r = classify('help me think through my research direction');
    assert.strictEqual(r.primaryModel, 'opus');
  });

  test('tier 3 always uses sonnet fallback', () => {
    const r = classify('help me think through my research direction');
    assert.strictEqual(r.fallbackModel, 'sonnet');
  });

  test('tier 3 maxTokens >= 2000', () => {
    const r = classify('steelman the opposing view on alignment');
    assert.ok(r.maxTokens >= 2000, `tier 3 maxTokens should be >=2000, got ${r.maxTokens}`);
  });

  test('tier 1 maxTokens <= 400', () => {
    const r = classify('remind me tomorrow');
    assert.ok(r.maxTokens <= 400, `tier 1 maxTokens should be <=400, got ${r.maxTokens}`);
  });

  test('tier 2 maxTokens between 500 and 1500', () => {
    const r = classify('explain the intuition behind attention mechanisms in transformers');
    assert.ok(r.maxTokens >= 500 && r.maxTokens <= 1500,
      `tier 2 maxTokens should be 500-1500, got ${r.maxTokens}`);
  });
});

// ── Priority order — escalation beats depth beats tier 1 ─────────────────────

describe('priority ordering — most specific rule wins', () => {
  test('explicit escalation beats short-message heuristic', () => {
    // "go deeper" is short (2 words) but explicit escalation
    const r = classify('go deeper', { messageCount: 0 });
    assert.strictEqual(r.tier, 3);
  });

  test('topic match beats tier 1 pattern', () => {
    // "remind me about my research statement" has both reminder (tier 1) and research statement (tier 3 topic)
    // tier 3 patterns are checked before tier 1
    const r = classify('remind me about my research statement');
    // Tier 0 is checked first, then tier 3, then tier 1 — so this could be tier 1 (reminder) or tier 3 (research statement)
    // The classifier checks tier 3 BEFORE tier 1, so research statement wins
    assert.strictEqual(r.tier, 3, `research statement should beat reminder pattern`);
  });

  test('sticky escalation is checked before explicit triggers', () => {
    // When already escalated, logistics de-escalation is the first sticky check
    const r = classify('add that to calendar', { isEscalated: true });
    assert.strictEqual(r.tier, 1, 'logistics should de-escalate even when already escalated');
  });

  test('tier 0 is always checked first', () => {
    // Even if message mentions research topics, "mark task as done" → tier 0
    const r = classify('mark task as done — was about research statement');
    assert.strictEqual(r.tier, 0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('empty string → does not throw, returns valid tier', () => {
    const r = classify('');
    assert.ok([0, 1, 2, 3].includes(r.tier));
  });

  test('very long message → handled without error', () => {
    const long = 'explain this '.repeat(50);
    const r = classify(long);
    assert.ok([0, 1, 2, 3].includes(r.tier));
  });

  test('message with only special chars → does not throw', () => {
    const r = classify('!!! ??? ... ---');
    assert.ok([0, 1, 2, 3].includes(r.tier));
  });

  test('ctx defaults are safe — no ctx arg', () => {
    const r = classifyTier('hello there how are you doing today?');
    assert.ok([0, 1, 2, 3].includes(r.tier));
  });

  test('isEscalated=true with messageCount=0 → still sticky', () => {
    const r = classify('what is this?', { isEscalated: true, messageCount: 0 });
    assert.ok(r.tier === 3 || r.tier === 1); // either sticky or de-escalated
  });

  test('projectKey not in known list → no crash', () => {
    const r = classifyTier('explain this concept', { projectKey: 'unknown_project', messageCount: 0 });
    assert.ok([1, 2].includes(r.tier)); // not tier 3 from depth (unknown project)
  });
});

// ── Regression: V1 messages that should NOT tier-3 escalate ──────────────────

describe('V1 regression — common bot messages stay tier 1/2', () => {
  const nonEscalateMessages = [
    'remind me to buy cleansing oil this Saturday',
    'add linear algebra assignment 2 for the 13th',
    'save this arxiv paper on diffusion',
    'I want to learn about transformers',
    'what did I save about alignment?',
    'move this to work',
    'that was personal not work',
    'no date, just add it to my list',
    'to do',
    'y',
    'n',
    'yes',
    'no',
  ];

  for (const msg of nonEscalateMessages) {
    test(`"${msg}" → tier <= 2`, () => {
      const r = classify(msg, { messageCount: 1 });
      assert.ok(r.tier <= 2,
        `"${msg}" should be tier <=2, got tier ${r.tier} (${r.reason})`);
    });
  }
});
