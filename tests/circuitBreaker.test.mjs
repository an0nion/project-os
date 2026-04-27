/**
 * Circuit breaker tests.
 *
 * Run: node --test tests/circuitBreaker.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOpen,
  recordFailure,
  recordSuccess,
  withBreaker,
  _resetAll,
  _getState,
  _config,
} from '../lib/circuitBreaker.js';

beforeEach(() => _resetAll());

describe('circuitBreaker', () => {
  test('starts closed', () => {
    assert.equal(isOpen('p1'), false);
    assert.equal(_getState('p1'), 'closed');
  });

  test('3 consecutive failures opens the breaker', () => {
    recordFailure('p1');
    assert.equal(_getState('p1'), 'closed');
    recordFailure('p1');
    assert.equal(_getState('p1'), 'closed');
    recordFailure('p1');
    assert.equal(_getState('p1'), 'open');
    assert.equal(isOpen('p1'), true);
  });

  test('a success resets the failure counter', () => {
    recordFailure('p1');
    recordFailure('p1');
    recordSuccess('p1');
    recordFailure('p1');
    recordFailure('p1');
    // only 2 failures since the success — should still be closed
    assert.equal(_getState('p1'), 'closed');
  });

  test('withBreaker throws immediately during open period without invoking fn', async () => {
    // Open the breaker
    recordFailure('p1');
    recordFailure('p1');
    recordFailure('p1');
    assert.equal(isOpen('p1'), true);

    let invoked = false;
    await assert.rejects(
      () => withBreaker('p1', async () => { invoked = true; return 'ok'; }),
      err => err.code === 'CIRCUIT_OPEN' && err.provider === 'p1',
    );
    assert.equal(invoked, false, 'underlying fn must not be invoked when breaker open');
  });

  test('after OPEN_DURATION_MS the breaker transitions to half-open and trial runs', async () => {
    // Open the breaker
    recordFailure('p1');
    recordFailure('p1');
    recordFailure('p1');
    assert.equal(_getState('p1'), 'open');

    // Simulate time passing past OPEN_DURATION_MS by checking isOpen with a future `now`.
    const future = Date.now() + _config.OPEN_DURATION_MS + 1;
    assert.equal(isOpen('p1', future), false, 'should transition open → half-open');
    assert.equal(_getState('p1'), 'half-open');

    // A successful trial should close the breaker.
    let invoked = false;
    const result = await withBreaker('p1', async () => { invoked = true; return 'ok'; });
    assert.equal(invoked, true);
    assert.equal(result, 'ok');
    assert.equal(_getState('p1'), 'closed');
  });

  test('half-open trial failure re-opens breaker immediately', async () => {
    // Open then time-travel to half-open.
    recordFailure('p2'); recordFailure('p2'); recordFailure('p2');
    isOpen('p2', Date.now() + _config.OPEN_DURATION_MS + 1);
    assert.equal(_getState('p2'), 'half-open');

    await assert.rejects(
      () => withBreaker('p2', async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(_getState('p2'), 'open', 'half-open trial failure must re-open');
  });

  test('breakers are per-provider', () => {
    recordFailure('a'); recordFailure('a'); recordFailure('a');
    assert.equal(_getState('a'), 'open');
    assert.equal(_getState('b'), 'closed');
    assert.equal(isOpen('b'), false);
  });
});
