/**
 * supabaseQuery — unit tests
 *
 * Verifies the soft-delete-aware query helper:
 *  - selectFrom(table) appends .is('deleted_at', null) by default
 *  - selectFrom(table, { includeDeleted: true }) does NOT append the filter
 *  - chaining (.eq, .order, .limit) still works on the returned builder
 *  - softDelete(table) issues an UPDATE with deleted_at set, never a DELETE
 *
 * Run: node --test tests/supabaseQuery.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectFrom, softDelete } from '../lib/supabaseQuery.js';

// ── mock supabase client ──────────────────────────────────────────────────────

function makeMockClient() {
  const calls = [];

  function makeBuilder(table, op) {
    const builder = {
      _table: table,
      _op: op,
      _chain: [],
    };
    const handler = {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Every chain method returns the same builder and records itself.
        return (...args) => {
          target._chain.push({ method: prop, args });
          return proxy;
        };
      },
    };
    const proxy = new Proxy(builder, handler);
    return proxy;
  }

  const client = {
    from(table) {
      const apiForTable = {
        select(columns, selectOptions) {
          const b = makeBuilder(table, 'select');
          b._select = { columns, selectOptions };
          calls.push(b);
          return b;
        },
        update(values) {
          const b = makeBuilder(table, 'update');
          b._update = values;
          calls.push(b);
          return b;
        },
        delete() {
          const b = makeBuilder(table, 'delete');
          calls.push(b);
          return b;
        },
        insert(values) {
          const b = makeBuilder(table, 'insert');
          b._insert = values;
          calls.push(b);
          return b;
        },
      };
      return apiForTable;
    },
    _calls: calls,
  };
  return client;
}

// ── selectFrom ────────────────────────────────────────────────────────────────

describe('selectFrom — soft-delete filter', () => {
  test('default: appends .is("deleted_at", null)', () => {
    const client = makeMockClient();
    selectFrom('items', { client });

    const call = client._calls[0];
    assert.equal(call._op, 'select');
    assert.equal(call._table, 'items');

    // The first chain call should be .is('deleted_at', null)
    const isCall = call._chain.find(c => c.method === 'is');
    assert.ok(isCall, 'expected .is() to be called');
    assert.deepEqual(isCall.args, ['deleted_at', null]);
  });

  test('includeDeleted: true — does NOT add .is filter', () => {
    const client = makeMockClient();
    selectFrom('items', { client, includeDeleted: true });

    const call = client._calls[0];
    const isCall = call._chain.find(c => c.method === 'is');
    assert.equal(isCall, undefined, 'should not call .is() when includeDeleted is true');
  });

  test('passes columns string to .select()', () => {
    const client = makeMockClient();
    selectFrom('applications', { client, columns: 'id, name' });
    assert.equal(client._calls[0]._select.columns, 'id, name');
  });

  test('default columns is "*"', () => {
    const client = makeMockClient();
    selectFrom('items', { client });
    assert.equal(client._calls[0]._select.columns, '*');
  });

  test('passes selectOptions (e.g. count) through to .select()', () => {
    const client = makeMockClient();
    selectFrom('items', { client, selectOptions: { count: 'exact', head: true } });
    assert.deepEqual(client._calls[0]._select.selectOptions, { count: 'exact', head: true });
  });

  test('returned builder supports chaining .eq/.order/.limit', () => {
    const client = makeMockClient();
    const q = selectFrom('items', { client })
      .eq('project_key', 'inbox')
      .order('position')
      .limit(10);

    const chain = client._calls[0]._chain;
    const methods = chain.map(c => c.method);
    assert.ok(methods.includes('is'),    'is should be in chain');
    assert.ok(methods.includes('eq'),    'eq should be in chain');
    assert.ok(methods.includes('order'), 'order should be in chain');
    assert.ok(methods.includes('limit'), 'limit should be in chain');
    assert.ok(q, 'chained call should return a truthy builder');
  });

  test('different tables produce independent builders', () => {
    const client = makeMockClient();
    selectFrom('items', { client });
    selectFrom('applications', { client });

    assert.equal(client._calls.length, 2);
    assert.equal(client._calls[0]._table, 'items');
    assert.equal(client._calls[1]._table, 'applications');
  });
});

// ── softDelete ────────────────────────────────────────────────────────────────

describe('softDelete — UPDATE with deleted_at', () => {
  test('issues UPDATE, never DELETE', () => {
    const client = makeMockClient();
    softDelete('items', { client }).eq('id', 'abc');

    const call = client._calls[0];
    assert.equal(call._op, 'update', 'should be UPDATE not DELETE');
  });

  test('sets deleted_at to a timestamp string', () => {
    const client = makeMockClient();
    softDelete('items', { client });

    const call = client._calls[0];
    assert.ok(call._update.deleted_at, 'deleted_at must be set');
    // Must be parseable as a date.
    const parsed = new Date(call._update.deleted_at);
    assert.ok(!isNaN(parsed.getTime()), 'deleted_at must be a valid timestamp');
  });

  test('returned builder supports chaining .eq', () => {
    const client = makeMockClient();
    softDelete('applications', { client }).eq('id', 'xyz');

    const chain = client._calls[0]._chain;
    const eqCall = chain.find(c => c.method === 'eq');
    assert.ok(eqCall, '.eq should be chainable on softDelete');
    assert.deepEqual(eqCall.args, ['id', 'xyz']);
  });
});
