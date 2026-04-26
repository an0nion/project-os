/**
 * Unit tests for lib/auth.js — requireAuth() and helpers.
 *
 * Run: node --test tests/auth.test.mjs
 *
 * Supabase is mocked (replaces the singleton client passed via opts.client),
 * so no network or real env vars are required.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Provide harmless env values BEFORE importing the module so any module-load
// time reads succeed.
process.env.APP_SECRET     = process.env.APP_SECRET     || 'test-app-secret';
process.env.CRON_SECRET    = process.env.CRON_SECRET    || 'test-cron-secret';
process.env.SUPABASE_URL   = process.env.SUPABASE_URL   || 'http://localhost';
process.env.SUPABASE_KEY   = process.env.SUPABASE_KEY   || 'test-anon-key';

const auth = await import('../lib/auth.js');
const { requireAuth, _resetForTests } = auth;

// ── helpers ────────────────────────────────────────────────────────────────

function makeReq({ headers = {}, cookie } = {}) {
  // Match the subset of NextRequest/Request that lib/auth.js touches.
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (cookie) h.set('cookie', cookie);
  return {
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    // Simulate NextRequest.cookies.get() returning { value }
    cookies: {
      get: (name) => {
        const c = h.get('cookie');
        if (!c) return undefined;
        for (const pair of c.split(';')) {
          const [n, ...rest] = pair.trim().split('=');
          if (n === name) return { value: rest.join('=') };
        }
        return undefined;
      },
    },
  };
}

/**
 * Build a fake supabase-client with a stubbed `from('session_tokens')` chain.
 * `tokens` is a Map<token, { expires_at: ISO }>.
 */
function makeSupabaseStub(tokens = new Map()) {
  return {
    from(table) {
      assert.equal(table, 'session_tokens', 'unexpected table');
      const builder = {
        _filterToken: null,
        select() { return builder; },
        eq(col, val) {
          assert.equal(col, 'token');
          builder._filterToken = val;
          return builder;
        },
        async maybeSingle() {
          const row = tokens.get(builder._filterToken);
          return row ? { data: { token: builder._filterToken, user_id: row.user_id ?? null, expires_at: row.expires_at }, error: null }
                     : { data: null, error: null };
        },
        async insert(row) {
          tokens.set(row.token, { expires_at: row.expires_at, user_id: row.user_id });
          return { error: null };
        },
        delete() { return builder; },
      };
      return builder;
    },
  };
}

// ── apiSecret ──────────────────────────────────────────────────────────────

describe('requireAuth({ kind: "apiSecret" })', () => {
  test('accepts matching x-api-secret', async () => {
    const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'test-app-secret' } }), { kind: 'apiSecret' });
    assert.equal(r.ok, true);
  });

  test('rejects missing header', async () => {
    const r = await requireAuth(makeReq(), { kind: 'apiSecret' });
    assert.equal(r.ok, false);
  });

  test('rejects wrong header', async () => {
    const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'nope' } }), { kind: 'apiSecret' });
    assert.equal(r.ok, false);
  });
});

// ── cron ───────────────────────────────────────────────────────────────────

describe('requireAuth({ kind: "cron" })', () => {
  test('accepts matching Bearer token', async () => {
    const r = await requireAuth(makeReq({ headers: { authorization: 'Bearer test-cron-secret' } }), { kind: 'cron' });
    assert.equal(r.ok, true);
  });

  test('rejects missing Authorization', async () => {
    const r = await requireAuth(makeReq(), { kind: 'cron' });
    assert.equal(r.ok, false);
  });

  test('rejects raw secret without Bearer prefix', async () => {
    const r = await requireAuth(makeReq({ headers: { authorization: 'test-cron-secret' } }), { kind: 'cron' });
    assert.equal(r.ok, false);
  });
});

// ── costLog ────────────────────────────────────────────────────────────────

describe('requireAuth({ kind: "costLog" })', () => {
  beforeEach(() => { _resetForTests(); });

  test('accepts COST_LOG_SECRET when set', async () => {
    process.env.COST_LOG_SECRET = 'cost-secret-123';
    const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'cost-secret-123' } }), { kind: 'costLog' });
    assert.equal(r.ok, true);
    delete process.env.COST_LOG_SECRET;
  });

  test('falls back to APP_SECRET (with warning) when COST_LOG_SECRET unset', async () => {
    delete process.env.COST_LOG_SECRET;
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'test-app-secret' } }), { kind: 'costLog' });
      assert.equal(r.ok, true);
      assert.ok(warnings.some((w) => w.includes('costLog accepted via APP_SECRET fallback')));
    } finally {
      console.warn = origWarn;
    }
  });

  test('rejects bad secret', async () => {
    delete process.env.COST_LOG_SECRET;
    const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'wrong' } }), { kind: 'costLog' });
    assert.equal(r.ok, false);
  });

  test('does NOT accept APP_SECRET when COST_LOG_SECRET is set and different', async () => {
    process.env.COST_LOG_SECRET = 'cost-secret-456';
    const r = await requireAuth(makeReq({ headers: { 'x-api-secret': 'test-app-secret' } }), { kind: 'costLog' });
    assert.equal(r.ok, false);
    delete process.env.COST_LOG_SECRET;
  });
});

// ── session (cookie) ───────────────────────────────────────────────────────

describe('requireAuth({ kind: "session" })', () => {
  test('rejects missing cookie', async () => {
    const tokens = new Map();
    const r = await requireAuth(makeReq(), { kind: 'session', client: makeSupabaseStub(tokens) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_cookie');
  });

  test('rejects unknown token', async () => {
    const r = await requireAuth(
      makeReq({ cookie: 'session=ghost' }),
      { kind: 'session', client: makeSupabaseStub(new Map()) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_or_expired');
  });

  test('rejects expired token', async () => {
    const tokens = new Map([['t1', { expires_at: new Date(Date.now() - 1000).toISOString() }]]);
    const r = await requireAuth(
      makeReq({ cookie: 'session=t1' }),
      { kind: 'session', client: makeSupabaseStub(tokens) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_or_expired');
  });

  test('accepts valid unexpired token and returns userId', async () => {
    const tokens = new Map([
      ['good', { expires_at: new Date(Date.now() + 60_000).toISOString(), user_id: 'u-42' }],
    ]);
    const r = await requireAuth(
      makeReq({ cookie: 'session=good' }),
      { kind: 'session', client: makeSupabaseStub(tokens) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.userId, 'u-42');
  });
});

// ── unknown kind ───────────────────────────────────────────────────────────

describe('requireAuth — unknown kind', () => {
  test('returns ok:false for an unknown kind', async () => {
    const r = await requireAuth(makeReq(), { kind: 'bogus' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_kind');
  });
});

// ── createSession round-trip ───────────────────────────────────────────────

describe('createSession + lookupSession', () => {
  test('issues a 64-char hex token that lookupSession can find', async () => {
    const tokens = new Map();
    const stub = makeSupabaseStub(tokens);
    const { createSession, lookupSession } = auth;
    const { token, maxAge } = await createSession('u-1', stub);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(maxAge, 60 * 60 * 24 * 30);
    const row = await lookupSession(token, stub);
    assert.ok(row);
    assert.equal(row.user_id, 'u-1');
  });
});
