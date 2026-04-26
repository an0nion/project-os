/**
 * Direct tests for lib/botHelpers.js — happy-path coverage for each pure helper
 * extracted in Unit 1a.
 *
 * tests/bot-flow.test.mjs covers many edge cases for these helpers via re-import;
 * this file documents the public contract of the module and gives each helper at
 * least one dedicated assertion.
 *
 * Run: node --test tests/botHelpers.test.mjs
 */

// process.env.APP_URL is read lazily inside buildSuccessMessage / buildReminderMessage.
// Set BEFORE the first call. This file is the canonical test-time value.
process.env.APP_URL = process.env.APP_URL ?? 'https://project-os.vercel.app';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_EMOJI,
  buildSuccessMessage,
  buildReminderMessage,
  buildEnrichedText,
  parseClarificationContext,
  extractUrls,
  normaliseTask,
} from '../lib/botHelpers.js';

describe('botHelpers — PROJECT_EMOJI map', () => {
  test('contains all 11 expected project keys', () => {
    const expected = [
      'personal','learning_tech','work','school','research_apps',
      'baking','beadwork','art','reading','exercise','circuitry',
    ];
    for (const k of expected) assert.ok(PROJECT_EMOJI[k], `missing emoji for ${k}`);
  });
});

describe('botHelpers — buildSuccessMessage', () => {
  test('returns linked title with project emoji', () => {
    const msg = buildSuccessMessage({ project: 'learning_tech', summary: 'Linear Probes' }, {});
    assert.ok(msg.startsWith('📚'));
    assert.ok(msg.includes('|Linear Probes>'));
    assert.ok(msg.includes(`${process.env.APP_URL}/project/learning_tech`));
  });

  test('appends timeline when present in cls', () => {
    const msg = buildSuccessMessage(
      { project: 'school', summary: 'Physics exam' },
      { timeline: 'next Friday' },
    );
    assert.ok(msg.includes('next Friday'));
    assert.ok(msg.includes(' · '));
  });

  test('falls back to "saved" when summary is empty', () => {
    const msg = buildSuccessMessage({ project: 'art', summary: '' }, {});
    assert.ok(msg.endsWith('saved'));
  });

  test('unknown project falls back to 📁', () => {
    const msg = buildSuccessMessage({ project: 'no_such_project', summary: 'x' }, {});
    assert.ok(msg.startsWith('📁'));
  });
});

describe('botHelpers — buildReminderMessage', () => {
  test('produces 🗓️ to-do format with link to personal board', () => {
    const msg = buildReminderMessage({ summary: 'Buy milk' }, {});
    assert.ok(msg.startsWith('🗓️'));
    assert.ok(msg.includes('|Buy milk>'));
    assert.ok(msg.includes(`${process.env.APP_URL}/project/personal`));
  });

  test('includes timeline note when cls.timeline is set', () => {
    const msg = buildReminderMessage({ summary: 'Buy milk' }, { timeline: 'tomorrow' });
    assert.ok(msg.includes(' · tomorrow'));
  });

  test('null summary falls back to "reminder"', () => {
    const msg = buildReminderMessage({ summary: null }, {});
    assert.ok(msg.includes('|reminder>'));
  });
});

describe('botHelpers — buildEnrichedText', () => {
  test('prepends [Work] tag when context is "work"', () => {
    const out = buildEnrichedText('work', null, 'fix prod bug', null);
    assert.ok(out.startsWith('[Work]'));
    assert.ok(out.includes('fix prod bug'));
  });

  test('prepends [Personal] tag when context is "personal"', () => {
    const out = buildEnrichedText('personal', null, 'dentist appt', null);
    assert.ok(out.startsWith('[Personal]'));
  });

  test('appends "— timeline" when timeline is present', () => {
    const out = buildEnrichedText(null, 'next week', 'submit form', null);
    assert.ok(out.includes('— next week'));
  });

  test('strips url from text when text contains the url', () => {
    const out = buildEnrichedText(null, null, 'check https://example.com out', 'https://example.com');
    assert.ok(!out.includes('https://example.com'));
    assert.ok(out.includes('check'));
  });
});

describe('botHelpers — parseClarificationContext', () => {
  test('"work stuff" → "work"', () => {
    assert.equal(parseClarificationContext('work stuff'), 'work');
  });

  test('"personal" → "personal"', () => {
    assert.equal(parseClarificationContext('personal'), 'personal');
  });

  test('bare "w" → "work"', () => {
    assert.equal(parseClarificationContext('w'), 'work');
  });

  test('bare "p" → "personal"', () => {
    assert.equal(parseClarificationContext('p'), 'personal');
  });

  test('unrelated text → null', () => {
    assert.equal(parseClarificationContext('hello there'), null);
  });
});

describe('botHelpers — extractUrls', () => {
  test('extracts http/https from text', () => {
    const urls = extractUrls({ text: 'check https://arxiv.org/abs/123 and http://example.com' });
    assert.equal(urls.length, 2);
    assert.ok(urls.includes('https://arxiv.org/abs/123'));
    assert.ok(urls.includes('http://example.com'));
  });

  test('ignores slack.com / slack-edge.com URLs', () => {
    const urls = extractUrls({ text: 'see https://slack.com/foo and https://example.com' });
    assert.equal(urls.length, 1);
    assert.ok(urls.includes('https://example.com'));
  });

  test('dedupes repeated URLs', () => {
    const urls = extractUrls({ text: 'https://example.com https://example.com' });
    assert.equal(urls.length, 1);
  });

  test('extracts urls from rich-text link elements', () => {
    const message = {
      blocks: [{
        elements: [{
          elements: [
            { type: 'link', url: 'https://arxiv.org/abs/2306.01234' },
          ],
        }],
      }],
    };
    const urls = extractUrls(message);
    assert.ok(urls.includes('https://arxiv.org/abs/2306.01234'));
  });

  test('extracts urls from attachments', () => {
    const message = {
      attachments: [{ original_url: 'https://example.com/page' }],
    };
    const urls = extractUrls(message);
    assert.ok(urls.includes('https://example.com/page'));
  });

  test('returns empty array for messages with no urls', () => {
    assert.deepEqual(extractUrls({ text: 'hello world' }), []);
  });
});

describe('botHelpers — normaliseTask', () => {
  test('valid intent passes through', () => {
    assert.equal(normaliseTask({ intent: 'reminder' }).intent, 'reminder');
  });

  test('invalid intent → "save"', () => {
    assert.equal(normaliseTask({ intent: 'unknown_xyz' }).intent, 'save');
  });

  test('valid project_hint passes through', () => {
    assert.equal(normaliseTask({ intent: 'save', project_hint: 'learning_tech' }).project_hint, 'learning_tech');
  });

  test('invalid project_hint → null', () => {
    assert.equal(normaliseTask({ intent: 'save', project_hint: 'fake_project' }).project_hint, null);
  });

  test('priority_tier in [1,4] passes through', () => {
    assert.equal(normaliseTask({ intent: 'save', priority_tier: 2 }).priority_tier, 2);
  });

  test('priority_tier out of range → null', () => {
    assert.equal(normaliseTask({ intent: 'save', priority_tier: 99 }).priority_tier, null);
  });

  test('priority_tier non-integer → null', () => {
    assert.equal(normaliseTask({ intent: 'save', priority_tier: 'high' }).priority_tier, null);
  });

  test('whitespace-only title → null', () => {
    assert.equal(normaliseTask({ intent: 'save', title: '   ' }).title, null);
  });

  test('valid title is trimmed', () => {
    assert.equal(normaliseTask({ intent: 'save', title: '  My Task  ' }).title, 'My Task');
  });

  test('needs_clarification only true when explicitly true', () => {
    assert.equal(normaliseTask({ intent: 'save' }).needs_clarification, false);
    assert.equal(normaliseTask({ intent: 'save', needs_clarification: 'yes' }).needs_clarification, false);
    assert.equal(normaliseTask({ intent: 'save', needs_clarification: true }).needs_clarification, true);
  });
});
