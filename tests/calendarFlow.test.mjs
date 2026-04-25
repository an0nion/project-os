/**
 * Unit 1c — Transactional inbox + calendar flow.
 *
 * Verifies the orphan-event prevention contract:
 *   (a) Both succeed → inbox row exists AND has calendar_event_id set.
 *   (b) Calendar fails → inbox row exists with calendar_event_id IS NULL,
 *       no orphan calendar event created.
 *   (c) Inbox fails → calendar API is never called (no orphan possible).
 *
 * The test replicates the bot's flow inline (see slack/bot.js:processReminderTask
 * and the reminderMode handler) to avoid importing Slack Bolt, which has
 * side effects at import time. If bot.js changes its inbox→calendar
 * sequencing, update the runReminderFlow helper below to match.
 *
 * Run: node --test tests/calendarFlow.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock supabase (in-memory items table) ────────────────────────────────────
function makeSupabaseMock() {
  const rows = new Map();
  let nextId = 1;
  let updateCalls = 0;

  const client = {
    from(table) {
      assert.equal(table, 'items', 'only items table is exercised');
      return {
        insert(row) {
          const id = `item-${nextId++}`;
          const stored = { id, calendar_event_id: null, ...row };
          rows.set(id, stored);
          return {
            select() {
              return {
                async single() { return { data: stored, error: null }; },
              };
            },
          };
        },
        update(patch) {
          return {
            async eq(_col, id) {
              updateCalls++;
              const row = rows.get(id);
              if (row) Object.assign(row, patch);
              return { data: row ?? null, error: row ? null : new Error('not found') };
            },
          };
        },
      };
    },
  };

  return { client, rows, get updateCalls() { return updateCalls; } };
}

// ── Mock fetch — answers /api/inbox and /api/calendar/event ──────────────────
// Behaviours are toggled per scenario via the `behaviour` argument.
function makeFetchMock({ inboxBehaviour, calendarBehaviour, supabaseMock }) {
  const calls = [];
  return async function mockFetch(url, opts = {}) {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });

    if (url.includes('/api/inbox')) {
      if (inboxBehaviour === 'fail') {
        return { ok: false, status: 500, async text() { return '{"error":"db down"}'; }, async json() { return { error: 'db down' }; } };
      }
      // Simulate the route inserting a row and returning itemId.
      const body = JSON.parse(opts.body);
      const insertResult = supabaseMock.client.from('items').insert({
        project_key: body.project ?? 'personal',
        title:       body.title ?? 'untitled',
      });
      const { data: row } = await insertResult.select().single();
      const responseBody = { project: body.project ?? 'personal', summary: body.title, itemId: row.id, logId: 'log-1' };
      return { ok: true, status: 200, async text() { return JSON.stringify(responseBody); }, async json() { return responseBody; } };
    }

    if (url.includes('/api/calendar/event')) {
      const body = JSON.parse(opts.body);
      if (calendarBehaviour === 'fail') {
        // Mirrors new route contract: HTTP 200 + { ok: false, error }.
        // Critically: the route does NOT touch the inbox row on failure.
        const responseBody = { ok: false, error: 'google calendar api: rate limited' };
        return { ok: true, status: 200, async text() { return JSON.stringify(responseBody); }, async json() { return responseBody; } };
      }
      // Success: link the inbox row (mirrors the route's UPDATE call).
      if (body.inbox_id) {
        await supabaseMock.client.from('items').update({ calendar_event_id: 'gcal-evt-123' }).eq('id', body.inbox_id);
      }
      const responseBody = { ok: true, eventId: 'gcal-evt-123', htmlLink: 'https://calendar.google.com/x' };
      return { ok: true, status: 200, async text() { return JSON.stringify(responseBody); }, async json() { return responseBody; } };
    }

    throw new Error(`unexpected fetch URL: ${url}`);
  };
}

// ── Replicates slack/bot.js reminder flow (see file header) ──────────────────
// 1. POST /api/inbox  → capture itemId
// 2. POST /api/calendar/event with inbox_id
// 3. If inbox fails → bail before calendar
// 4. If calendar fails → leave inbox row (calendar_event_id stays NULL)
async function runReminderFlow({ fetchImpl, title, date }) {
  // Step 1 — inbox
  let inboxId = null;
  const inboxRes = await fetchImpl('http://app/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': 'test' },
    body:   JSON.stringify({ text: title, title, source: 'slack', project: 'personal' }),
  });
  if (!inboxRes.ok) {
    return { inboxOk: false, calendarCalled: false, calendarOk: false, inboxId: null, message: "couldn't save that — try again" };
  }
  const inboxBody = await inboxRes.json();
  inboxId = inboxBody.itemId ?? null;

  // Step 2 — calendar (only if inbox succeeded)
  const calRes = await fetchImpl('http://app/api/calendar/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': 'test' },
    body:   JSON.stringify({ title, date, inbox_id: inboxId }),
  });
  let calendarOk = calRes.ok;
  if (calendarOk) {
    try {
      const body = await calRes.json();
      if (body && body.ok === false) calendarOk = false;
    } catch { /* tolerate */ }
  }

  return {
    inboxOk:        true,
    calendarCalled: true,
    calendarOk,
    inboxId,
    message: calendarOk
      ? `📅 ${title} · added to calendar`
      : `📅 ${title} · saved to inbox; calendar create failed — will retry later`,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Unit 1c — transactional inbox + calendar flow', () => {
  let supabaseMock;

  beforeEach(() => { supabaseMock = makeSupabaseMock(); });

  test('(a) both succeed → inbox row has calendar_event_id set', async () => {
    const fetchImpl = makeFetchMock({ inboxBehaviour: 'ok', calendarBehaviour: 'ok', supabaseMock });
    const result = await runReminderFlow({ fetchImpl, title: 'Pay rent', date: '2026-05-01' });

    assert.equal(result.inboxOk, true, 'inbox should succeed');
    assert.equal(result.calendarOk, true, 'calendar should succeed');
    assert.ok(result.inboxId, 'should capture inbox id');
    assert.match(result.message, /added to calendar/);

    const row = supabaseMock.rows.get(result.inboxId);
    assert.ok(row, 'items row should exist');
    assert.equal(row.calendar_event_id, 'gcal-evt-123', 'calendar_event_id should be linked');
  });

  test('(b) calendar fails → inbox row exists, calendar_event_id is null, no orphan', async () => {
    const fetchImpl = makeFetchMock({ inboxBehaviour: 'ok', calendarBehaviour: 'fail', supabaseMock });
    const result = await runReminderFlow({ fetchImpl, title: 'Dentist', date: '2026-05-10' });

    assert.equal(result.inboxOk, true, 'inbox should still succeed (no rollback)');
    assert.equal(result.calendarOk, false, 'calendar should be reported as failed');
    assert.ok(result.inboxId, 'inbox row id should still be returned');
    assert.match(result.message, /saved to inbox; calendar create failed/);

    const row = supabaseMock.rows.get(result.inboxId);
    assert.ok(row, 'items row must still exist (no rollback)');
    assert.equal(row.calendar_event_id, null, 'calendar_event_id must be NULL — backfill cron will retry');
    assert.equal(supabaseMock.updateCalls, 0, 'route must NOT update inbox row on calendar failure');
  });

  test('(c) inbox fails → calendar API is never called (no orphan possible)', async () => {
    const calls = [];
    const baseFetch = makeFetchMock({ inboxBehaviour: 'fail', calendarBehaviour: 'ok', supabaseMock });
    const fetchImpl = async (url, opts) => {
      calls.push(url);
      return baseFetch(url, opts);
    };
    const result = await runReminderFlow({ fetchImpl, title: 'Lunch', date: '2026-05-15' });

    assert.equal(result.inboxOk, false, 'inbox should fail');
    assert.equal(result.calendarCalled, false, 'calendar must NOT be called when inbox fails');
    assert.equal(supabaseMock.rows.size, 0, 'no items row should be created');
    assert.equal(calls.filter(u => u.includes('/api/calendar/event')).length, 0,
      'calendar endpoint must not be reached');
    assert.match(result.message, /couldn't save/);
  });
});

// ── Migration shape ──────────────────────────────────────────────────────────

describe('Unit 1c — migration 013 shape', () => {
  test('migration adds calendar_event_id column and index, idempotently', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../scripts/migrations/013_inbox_calendar_link.sql', import.meta.url);
    const sql = await fs.readFile(url, 'utf8');

    assert.match(sql, /ADD COLUMN IF NOT EXISTS calendar_event_id TEXT/i,
      'must add calendar_event_id column idempotently');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_items_calendar_event_id/i,
      'must create lookup index idempotently');
    assert.match(sql, /WHERE calendar_event_id IS NOT NULL/i,
      'index should be partial (skip NULLs) for cron efficiency');
  });
});
