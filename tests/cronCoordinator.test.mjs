/**
 * Cron coordinator tests — verifies Promise.allSettled fan-out semantics:
 *   - all 5 handlers run even if one throws
 *   - the result object includes one entry per handler
 *   - ok=true if any handler succeeds, false only if every one fails
 *
 * These tests pass *mock* handler modules into runCoordinator so they don't
 * trigger import-time side effects in the real handlers (Slack Bolt App,
 * Supabase client, etc.).
 *
 * Run: node --test tests/cronCoordinator.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCoordinator, HANDLER_NAMES }
  from '../app/api/cron/_handlers/coordinator.js';

function makeHandler(name, behavior) {
  let calls = 0;
  return {
    name,
    mod: {
      async run(db) {
        calls++;
        if (behavior === 'throw')   throw new Error(`${name} blew up`);
        if (behavior === 'reject')  return Promise.reject(new Error(`${name} rejected`));
        return { summary: `${name} ok`, db: !!db };
      },
    },
    get calls() { return calls; },
  };
}

describe('runCoordinator — Promise.allSettled fan-out', () => {
  test('runs all 5 handlers and returns one result per handler', async () => {
    const handlers = [
      makeHandler('deadlines',        'ok'),
      makeHandler('costDigest',       'ok'),
      makeHandler('briefing',         'ok'),
      makeHandler('dedupCleanup',     'ok'),
      makeHandler('calendarBackfill', 'ok'),
    ];
    const fakeDb = { from: () => ({}) };

    const { ok, results } = await runCoordinator(
      fakeDb,
      handlers.map(h => [h.name, h.mod]),
    );

    assert.equal(ok, true);
    assert.deepEqual(Object.keys(results).sort(),
      ['briefing', 'calendarBackfill', 'costDigest', 'deadlines', 'dedupCleanup']);
    for (const h of handlers) {
      assert.equal(h.calls, 1, `${h.name} should have been called exactly once`);
      assert.match(results[h.name], /^ok:/);
    }
  });

  test('a failing handler does NOT prevent the others from running', async () => {
    const handlers = [
      makeHandler('deadlines',        'ok'),
      makeHandler('costDigest',       'throw'),    // sync-style throw inside async
      makeHandler('briefing',         'ok'),
      makeHandler('dedupCleanup',     'reject'),   // returned rejection
      makeHandler('calendarBackfill', 'ok'),
    ];

    const { ok, results } = await runCoordinator(
      {},
      handlers.map(h => [h.name, h.mod]),
    );

    // Every handler invoked despite two failures.
    for (const h of handlers) {
      assert.equal(h.calls, 1, `${h.name} should still have run`);
    }

    // Result object contains all 5 keys.
    assert.equal(Object.keys(results).length, 5);

    // Successful ones marked ok, failed ones marked failed.
    assert.match(results.deadlines,        /^ok:/);
    assert.match(results.briefing,         /^ok:/);
    assert.match(results.calendarBackfill, /^ok:/);
    assert.match(results.costDigest,       /^failed: costDigest blew up/);
    assert.match(results.dedupCleanup,     /^failed: dedupCleanup rejected/);

    // ok=true because at least one succeeded.
    assert.equal(ok, true);
  });

  test('ok=false only when every handler fails', async () => {
    const handlers = [
      makeHandler('a', 'throw'),
      makeHandler('b', 'reject'),
    ];
    const { ok, results } = await runCoordinator(
      {},
      handlers.map(h => [h.name, h.mod]),
    );
    assert.equal(ok, false);
    assert.match(results.a, /^failed:/);
    assert.match(results.b, /^failed:/);
  });

  test('HANDLER_NAMES lists exactly the 5 expected keys', () => {
    assert.deepEqual([...HANDLER_NAMES].sort(),
      ['briefing', 'calendarBackfill', 'costDigest', 'deadlines', 'dedupCleanup']);
  });
});
