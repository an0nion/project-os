/**
 * Tests for the unified cost logger.
 *
 * Covers:
 *   - env-aware routing: SUPABASE_SERVICE_KEY present → supabase write
 *   - env-aware routing: SUPABASE_SERVICE_KEY absent → fetch to /api/costs/log
 *   - failures are swallowed (never thrown)
 *   - meta normalisation: bare reason string accepted
 *   - calculateCost basic correctness
 *
 * Run: node --test tests/costLog.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// supabase.js calls createClient at module init, which throws without these.
// Set BEFORE the first dynamic import of any module that touches supabase.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-anon-key';

// ── Test setup ────────────────────────────────────────────────────────────────
// Each test resets env and mocks. We import costLog.js fresh per test path so
// the lazy supabase import sees the mocked module each time.

// Snapshot AFTER stubs are set so beforeEach restores include the stubs.
const ORIGINAL_ENV   = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ERR   = console.error;

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
}

function mockSupabaseSuccess() {
  const calls = [];
  const mock = {
    supabase: {
      from(table) {
        return {
          insert(row) {
            calls.push({ table, row });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  return { mock, calls };
}

beforeEach(() => {
  restoreEnv();
  // Strip cost-logging env to start from a known state
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.APP_URL;
  delete process.env.APP_SECRET;
  delete process.env.COST_LOG_SECRET;
  globalThis.fetch = ORIGINAL_FETCH;
  console.error    = () => {};   // silence expected-error logs
});

afterEach(() => {
  restoreEnv();
  globalThis.fetch = ORIGINAL_FETCH;
  console.error    = ORIGINAL_ERR;
});

// ── calculateCost ─────────────────────────────────────────────────────────────

describe('calculateCost', () => {
  test('returns zeros for unknown model', async () => {
    const { calculateCost } = await import('../lib/costLog.js');
    const r = calculateCost('not-a-model', { input_tokens: 100, output_tokens: 50 });
    assert.equal(r.totalCost, 0);
    assert.equal(r.tier, 0);
  });

  test('returns zeros for missing usage', async () => {
    const { calculateCost } = await import('../lib/costLog.js');
    const r = calculateCost('gemini-flash', null);
    assert.equal(r.totalCost, 0);
  });

  test('computes positive cost for a real model + usage', async () => {
    const { calculateCost } = await import('../lib/costLog.js');
    const r = calculateCost('gemini-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    assert.ok(r.totalCost > 0, 'expected non-zero cost');
    assert.equal(r.tier, 1);
  });
});

// ── Routing: SUPABASE_SERVICE_KEY present → supabase path ────────────────────

describe('logCost — supabase routing', () => {
  test('writes to supabase when SUPABASE_SERVICE_KEY is set', async () => {
    process.env.SUPABASE_SERVICE_KEY = 'service-key';

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true };
    };

    // Inject a mock supabase by stubbing the module via cache-bust import.
    // Since we cannot easily mock dynamic imports, we instead use a
    // controlled intercept: monkey-patch the module after first import.
    const { mock, calls } = mockSupabaseSuccess();
    const supabaseModule  = await import('../lib/supabase.js');
    const originalFrom    = supabaseModule.supabase.from;
    supabaseModule.supabase.from = mock.supabase.from;

    try {
      const { logCost } = await import('../lib/costLog.js');
      await logCost('gemini-flash', { input_tokens: 100, output_tokens: 20 }, { reason: 'unit-test' });

      assert.equal(fetchCalled, false, 'fetch must not be called when supabase routing is active');
      assert.equal(calls.length, 1, 'supabase insert should be called once');
      assert.equal(calls[0].table, 'cost_log');
      assert.equal(calls[0].row.reason, 'unit-test');
      assert.equal(calls[0].row.input_tokens, 100);
      assert.equal(calls[0].row.output_tokens, 20);
    } finally {
      supabaseModule.supabase.from = originalFrom;
    }
  });

  test('swallows supabase errors (never throws)', async () => {
    process.env.SUPABASE_SERVICE_KEY = 'service-key';

    const supabaseModule = await import('../lib/supabase.js');
    const originalFrom   = supabaseModule.supabase.from;
    supabaseModule.supabase.from = () => ({
      insert() { return Promise.reject(new Error('boom')); },
    });

    try {
      const { logCost } = await import('../lib/costLog.js');
      await assert.doesNotReject(
        logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 }, { reason: 'err-test' }),
      );
    } finally {
      supabaseModule.supabase.from = originalFrom;
    }
  });
});

// ── Routing: SUPABASE_SERVICE_KEY absent → fetch path ────────────────────────

describe('logCost — fetch routing', () => {
  test('POSTs to /api/costs/log when SUPABASE_SERVICE_KEY is unset', async () => {
    process.env.APP_URL    = 'http://example.test';
    process.env.APP_SECRET = 'shh';

    const fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true };
    };

    const { logCost } = await import('../lib/costLog.js');
    await logCost('gemini-flash', { input_tokens: 5, output_tokens: 7 }, { reason: 'fetch-test' });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://example.test/api/costs/log');
    assert.equal(fetchCalls[0].opts.method, 'POST');
    assert.equal(fetchCalls[0].opts.headers['x-api-secret'], 'shh');
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.modelKey, 'gemini-flash');
    assert.equal(body.reason,   'fetch-test');
  });

  test('prefers COST_LOG_SECRET over APP_SECRET when both set', async () => {
    process.env.APP_URL         = 'http://example.test';
    process.env.APP_SECRET      = 'old';
    process.env.COST_LOG_SECRET = 'new';

    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = opts;
      return { ok: true };
    };

    const { logCost } = await import('../lib/costLog.js');
    await logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 });

    assert.equal(captured.headers['x-api-secret'], 'new');
  });

  test('skips silently when APP_URL is unset', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };

    const { logCost } = await import('../lib/costLog.js');
    await assert.doesNotReject(
      logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 }, { reason: 'no-url' }),
    );
    assert.equal(fetchCalled, false);
  });

  test('swallows fetch errors (never throws)', async () => {
    process.env.APP_URL    = 'http://example.test';
    process.env.APP_SECRET = 'shh';
    globalThis.fetch       = async () => { throw new Error('network down'); };

    const { logCost } = await import('../lib/costLog.js');
    await assert.doesNotReject(
      logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 }, { reason: 'err' }),
    );
  });

  test('swallows non-OK responses (never throws)', async () => {
    process.env.APP_URL    = 'http://example.test';
    process.env.APP_SECRET = 'shh';
    globalThis.fetch       = async () => ({ ok: false, status: 500 });

    const { logCost } = await import('../lib/costLog.js');
    await assert.doesNotReject(
      logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 }),
    );
  });
});

// ── Meta normalisation ───────────────────────────────────────────────────────

describe('logCost — meta normalisation', () => {
  test('accepts a bare reason string (legacy vmCostLogger signature)', async () => {
    process.env.APP_URL    = 'http://example.test';
    process.env.APP_SECRET = 'shh';

    let captured;
    globalThis.fetch = async (_url, opts) => { captured = opts; return { ok: true }; };

    const { logCost } = await import('../lib/costLog.js');
    await logCost('gemini-flash', { input_tokens: 1, output_tokens: 1 }, 'legacy_reason');

    const body = JSON.parse(captured.body);
    assert.equal(body.reason, 'legacy_reason');
  });
});

// ── Guard: missing modelKey or usage ─────────────────────────────────────────

describe('logCost — guards', () => {
  test('returns silently when modelKey or usage is missing', async () => {
    process.env.SUPABASE_SERVICE_KEY = 'service-key';

    const supabaseModule = await import('../lib/supabase.js');
    const originalFrom   = supabaseModule.supabase.from;
    let called = false;
    supabaseModule.supabase.from = () => { called = true; return { insert: () => Promise.resolve({}) }; };

    try {
      const { logCost } = await import('../lib/costLog.js');
      await logCost(null,           { input_tokens: 1, output_tokens: 1 });
      await logCost('gemini-flash', null);
      assert.equal(called, false, 'supabase should never be called when inputs are missing');
    } finally {
      supabaseModule.supabase.from = originalFrom;
    }
  });
});
