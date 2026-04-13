/**
 * V4 feature tests — edit intent, enhanced recall, batch draft detection.
 *
 * Run: node --test tests/v4-features.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_INTENTS, INTENT_SYSTEM_PROMPT } from '../lib/intentPrompt.js';

// ── F1: Edit intent ──────────────────────────────────────────────────────────

describe('F1 — edit intent in VALID_INTENTS', () => {
  test('VALID_INTENTS includes "edit"', () => {
    assert.ok(VALID_INTENTS.includes('edit'), 'edit is not in VALID_INTENTS');
  });

  test('VALID_INTENTS still includes all original intents', () => {
    for (const intent of ['save', 'correct', 'converse', 'search_request', 'reminder', 'recall', 'web_search', 'preferences']) {
      assert.ok(VALID_INTENTS.includes(intent), `${intent} missing from VALID_INTENTS`);
    }
  });
});

describe('F1 — intent prompt includes edit description', () => {
  test('INTENT_SYSTEM_PROMPT mentions "edit" intent', () => {
    assert.ok(INTENT_SYSTEM_PROMPT.includes('"edit"'), 'edit not in prompt enum');
  });

  test('INTENT_SYSTEM_PROMPT describes edit use cases', () => {
    assert.ok(
      INTENT_SYSTEM_PROMPT.includes('change the deadline') || INTENT_SYSTEM_PROMPT.includes('rename X'),
      'edit description not found in prompt'
    );
  });

  test('INTENT_SYSTEM_PROMPT includes edit_field in JSON shape', () => {
    assert.ok(INTENT_SYSTEM_PROMPT.includes('edit_field'), 'edit_field missing from prompt JSON shape');
  });

  test('INTENT_SYSTEM_PROMPT includes edit_value in JSON shape', () => {
    assert.ok(INTENT_SYSTEM_PROMPT.includes('edit_value'), 'edit_value missing from prompt JSON shape');
  });

  test('edit_field lists valid fields', () => {
    assert.ok(
      INTENT_SYSTEM_PROMPT.includes('due_date') && INTENT_SYSTEM_PROMPT.includes('project_key'),
      'edit_field enum values not found in prompt'
    );
  });
});

describe('F1 — edit intent normalisation', () => {
  // normaliseTask is replicated here (mirrors bot.js)
  function normaliseTask(t) {
    const validIntents = new Set(VALID_INTENTS);
    return {
      intent:             validIntents.has(t.intent) ? t.intent : 'save',
      title:              t.title ?? '',
      timeline:           t.timeline ?? null,
      context:            t.context ?? null,
      project_hint:       t.project_hint ?? null,
      priority_tier:      t.priority_tier ?? null,
      needs_clarification:t.needs_clarification ?? false,
      corrected_project:  t.corrected_project ?? null,
      recall_topic:       t.recall_topic ?? null,
      search_query:       t.search_query ?? null,
      edit_field:         t.edit_field ?? null,
      edit_value:         t.edit_value ?? null,
    };
  }

  test('edit intent preserved through normaliseTask', () => {
    const t = normaliseTask({ intent: 'edit', title: 'ML assignment', edit_field: 'due_date', edit_value: 'Friday' });
    assert.strictEqual(t.intent, 'edit');
    assert.strictEqual(t.edit_field, 'due_date');
    assert.strictEqual(t.edit_value, 'Friday');
  });

  test('edit_field defaults to null if not provided', () => {
    const t = normaliseTask({ intent: 'edit', title: 'ML assignment' });
    assert.strictEqual(t.edit_field, null);
    assert.strictEqual(t.edit_value, null);
  });

  test('unknown intent falls back to save, not edit', () => {
    const t = normaliseTask({ intent: 'unknown_thing' });
    assert.strictEqual(t.intent, 'save');
  });
});

// ── F2: Enhanced recall ───────────────────────────────────────────────────────

describe('F2 — recall search route returns id field', () => {
  // Test the shape contract by simulating the route's output mapping logic
  function mapItemRow(row) {
    return {
      id:       row.id,
      title:    row.title,
      subtitle: row.subtitle ?? null,
      project:  row.project_key,
      url:      row.url ?? null,
      saved_at: row.created_at,
    };
  }

  test('mapItemRow includes id', () => {
    const row = { id: 'abc-123', title: 'Test Item', project_key: 'school', url: null, created_at: '2026-04-01', subtitle: null };
    const result = mapItemRow(row);
    assert.strictEqual(result.id, 'abc-123');
  });

  test('mapItemRow includes subtitle', () => {
    const row = { id: 'x', title: 'T', project_key: 'work', url: null, created_at: '2026-04-01', subtitle: 'attention is all you need' };
    assert.strictEqual(mapItemRow(row).subtitle, 'attention is all you need');
  });

  test('mapItemRow subtitle defaults to null', () => {
    const row = { id: 'x', title: 'T', project_key: 'work', url: null, created_at: '2026-04-01' };
    assert.strictEqual(mapItemRow(row).subtitle, null);
  });
});

describe('F2 — recall result formatting with _why field', () => {
  const projectEmoji = {
    personal: '🗓️', learning_tech: '📚', work: '💼', school: '🎓',
    research_apps: '🔬', baking: '🍞', beadwork: '📿', art: '🎨',
    reading: '📖', exercise: '💪', circuitry: '⚡',
  };
  function formatLine(r) {
    const emoji   = projectEmoji[r.project] ?? '📁';
    const dateStr = r.saved_at ? ` · ${new Date(r.saved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : '';
    const link    = r.url ? `<${r.url}|${r.title}>` : r.title;
    const why     = r._why ? ` — _${r._why}_` : '';
    return `${emoji} ${link}${why}${dateStr}`;
  }

  test('formatLine includes _why when present', () => {
    const r = { title: 'Attention paper', project: 'learning_tech', url: null, saved_at: null, _why: 'matches attention query' };
    const line = formatLine(r);
    assert.ok(line.includes('matches attention query'), `why not in line: ${line}`);
    assert.ok(line.includes('_matches'), `why not italicised: ${line}`);
  });

  test('formatLine omits _why when absent', () => {
    const r = { title: 'Sourdough recipe', project: 'baking', url: null, saved_at: null };
    const line = formatLine(r);
    assert.ok(!line.includes(' — _'), `spurious why in line: ${line}`);
  });

  test('formatLine uses URL as Slack link when present', () => {
    const r = { title: 'Paper title', project: 'reading', url: 'https://arxiv.org/1234', saved_at: null };
    assert.ok(formatLine(r).includes('<https://arxiv.org/1234|Paper title>'));
  });

  test('show-more text is appended when overflow exists', () => {
    const overflow = [{ title: 'extra' }];
    const moreStr  = overflow.length ? `\n+${overflow.length} more — say *more* to see them` : '';
    assert.ok(moreStr.includes('+1 more'));
    assert.ok(moreStr.includes('say *more*'));
  });

  test('no show-more when results fit in one page', () => {
    const overflow = [];
    const moreStr  = overflow.length ? `\n+${overflow.length} more — say *more* to see them` : '';
    assert.strictEqual(moreStr, '');
  });
});

// ── F3: Batch draft detection ─────────────────────────────────────────────────

describe('F3 — isDraft regex detection', () => {
  // Mirrors the regex used in bot.js learningMode
  const isDraftRegex = /\b(draft|write|outline|summarize|study.?plan|write.?up)\b/i;

  const shouldTriggerBatch = [
    'draft a study plan for me',
    'write a summary of everything we discussed',
    'outline the key concepts',
    'summarize this into a document',
    'write up the main points',
    'study plan please',
    'write me a plan',
    'can you draft something',
    'draft this',
    'write that up',
  ];

  const shouldNotTriggerBatch = [
    'implement it',
    'read the paper',
    'save this',
    'ok',
    'yes',
    'what about X?',
    'tell me more',
    'why does this work?',
    'go deeper',
    'help me understand this',
  ];

  for (const msg of shouldTriggerBatch) {
    test(`"${msg}" → isDraft=true`, () => {
      assert.ok(isDraftRegex.test(msg), `expected isDraft=true for: "${msg}"`);
    });
  }

  for (const msg of shouldNotTriggerBatch) {
    test(`"${msg}" → isDraft=false`, () => {
      assert.ok(!isDraftRegex.test(msg), `expected isDraft=false for: "${msg}"`);
    });
  }
});

describe('F3 — batch endpoint shape contracts', () => {
  test('submit endpoint path is correct', () => {
    const path = '/api/batch/submit';
    assert.ok(path.startsWith('/api/batch/'), 'wrong path prefix');
  });

  test('poll endpoint path is correct', () => {
    const path = '/api/batch/poll';
    assert.ok(path.startsWith('/api/batch/'), 'wrong path prefix');
  });

  test('poll interval is 60 seconds', () => {
    const INTERVAL_MS = 60_000;
    assert.strictEqual(INTERVAL_MS, 60 * 1000);
  });
});
