/**
 * Persistent Deduplicator unit tests.
 *
 * Uses an in-memory mock of the Supabase client so the tests don't touch the
 * network. The mock honours expires_at so we can simulate the TTL window
 * elapsing without sleeping.
 *
 * Run: node --test tests/deduplicator.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Stub env vars BEFORE importing the deduplicator — `lib/supabase.js`
// constructs a real client at module load time and refuses to start without
// these. The mock client we inject in each test fully replaces it for the
// code paths under test, so the real client is never actually called.
process.env.SUPABASE_URL ??= 'http://stub.local';
process.env.SUPABASE_KEY ??= 'stub-key';

const { Deduplicator } = await import('../lib/deduplicator.js');

// ── Minimal in-memory stand-in for the bits of supabase-js the dedup uses ────
function makeMockClient() {
  const rows = new Map(); // message_hash → { expires_at: ISO string }

  // Builder mirrors the chain: client.from(table).select(cols).eq(col,val).gt(col,val).limit(n).maybeSingle()
  function tableBuilder() {
    let filterHash = null;
    let filterAfterIso = null;

    const builder = {
      select() { return builder; },
      eq(col, val) {
        if (col === 'message_hash') filterHash = val;
        return builder;
      },
      gt(col, val) {
        if (col === 'expires_at') filterAfterIso = val;
        return builder;
      },
      limit() { return builder; },
      maybeSingle() {
        const row = rows.get(filterHash);
        if (!row) return Promise.resolve({ data: null, error: null });
        if (filterAfterIso && row.expires_at <= filterAfterIso) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: { message_hash: filterHash }, error: null });
      },
      insert(record) {
        // Row-level uniqueness: PK violation if hash already exists & not expired.
        const existing = rows.get(record.message_hash);
        if (existing && existing.expires_at > new Date().toISOString()) {
          return Promise.resolve({ data: null, error: { message: 'duplicate key' } });
        }
        rows.set(record.message_hash, { expires_at: record.expires_at });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  return {
    from() { return tableBuilder(); },
    _rows: rows,
  };
}

describe('Deduplicator (persistent)', () => {
  test('first call returns false, second call returns true', async () => {
    const client = makeMockClient();
    const d = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await d.seen('hash-A'), false);
    assert.equal(await d.seen('hash-A'), true);
  });

  test('distinct hashes are independent', async () => {
    const client = makeMockClient();
    const d = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await d.seen('hash-1'), false);
    assert.equal(await d.seen('hash-2'), false);
    assert.equal(await d.seen('hash-1'), true);
    assert.equal(await d.seen('hash-2'), true);
  });

  test('empty/null hash always returns false', async () => {
    const client = makeMockClient();
    const d = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await d.seen(null), false);
    assert.equal(await d.seen(''), false);
    assert.equal(await d.seen(undefined), false);
  });

  test('expired DB entries are treated as not seen', async () => {
    // Pre-seed an already-expired row directly into the mock.
    const client = makeMockClient();
    client._rows.set('hash-old', {
      expires_at: new Date(Date.now() - 60_000).toISOString(),  // 60s ago
    });
    const d = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await d.seen('hash-old'), false);
    // Re-inserted with a fresh window → second call now duplicates.
    assert.equal(await d.seen('hash-old'), true);
  });

  test('survives a "restart": new instance still sees the persisted hash', async () => {
    const client = makeMockClient();      // shared "DB" between two instances
    const before = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await before.seen('hash-restart'), false);

    // Simulate process restart: brand-new instance, empty in-memory cache.
    const after = new Deduplicator({ ttlSeconds: 90, client });
    assert.equal(await after.seen('hash-restart'), true);
  });
});
