import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, formatInTz, startOfDayInTz } from '../lib/timezone.js';

/**
 * DST boundaries for Australia/Melbourne in 2026:
 *   - April 5, 2026 03:00 AEDT → 02:00 AEST (clocks go BACK one hour)
 *   - October 4, 2026 02:00 AEST → 03:00 AEDT (clocks go FORWARD one hour)
 *
 * Acceptance: addDays(d, 1) across these boundaries must preserve the LOCAL
 * clock time. e.g. 09:00 on April 4 + 1 day = 09:00 on April 5 (zoned),
 * even though the elapsed UTC duration is 25 hours, not 24.
 */

describe('timezone DST safety (Australia/Melbourne 2026)', () => {
  let originalTz;
  before(() => {
    originalTz = process.env.APP_TIMEZONE;
    process.env.APP_TIMEZONE = 'Australia/Melbourne';
  });
  after(() => { process.env.APP_TIMEZONE = originalTz; });

  test('AEDT→AEST: addDays preserves local clock across April 5, 2026', () => {
    // April 4, 2026 09:00 Melbourne = 22:00 UTC April 3 (AEDT, UTC+11)
    const start = new Date('2026-04-03T22:00:00Z');
    assert.equal(formatInTz(start, 'yyyy-MM-dd HH:mm'), '2026-04-04 09:00');

    const next = addDays(start, 1);
    // Should land on April 5, 09:00 Melbourne local — even though that's
    // AEST (UTC+10), 23:00 UTC the previous day.
    assert.equal(formatInTz(next, 'yyyy-MM-dd HH:mm'), '2026-04-05 09:00');
  });

  test('AEDT→AEST: addDays across a date that spans the transition', () => {
    // April 5, 2026 12:00 Melbourne (already AEST after 03:00 AEDT rollback)
    const start = new Date('2026-04-05T02:00:00Z'); // 12:00 AEST
    assert.equal(formatInTz(start, 'yyyy-MM-dd HH:mm'), '2026-04-05 12:00');

    const next = addDays(start, 1);
    assert.equal(formatInTz(next, 'yyyy-MM-dd HH:mm'), '2026-04-06 12:00');
  });

  test('AEST→AEDT: addDays preserves local clock across October 4, 2026', () => {
    // October 3, 2026 09:00 Melbourne = 23:00 UTC October 2 (AEST, UTC+10)
    const start = new Date('2026-10-02T23:00:00Z');
    assert.equal(formatInTz(start, 'yyyy-MM-dd HH:mm'), '2026-10-03 09:00');

    const next = addDays(start, 1);
    // October 4 — clocks jumped forward at 02:00 → 03:00, but 09:00 local stays 09:00.
    assert.equal(formatInTz(next, 'yyyy-MM-dd HH:mm'), '2026-10-04 09:00');
  });

  test('AEST→AEDT: addDays across a date that spans the transition', () => {
    // October 4 12:00 Melbourne (already AEDT after spring-forward)
    const start = new Date('2026-10-04T01:00:00Z'); // 12:00 AEDT
    assert.equal(formatInTz(start, 'yyyy-MM-dd HH:mm'), '2026-10-04 12:00');

    const next = addDays(start, 1);
    assert.equal(formatInTz(next, 'yyyy-MM-dd HH:mm'), '2026-10-05 12:00');
  });

  test('Naive Date math FAILS at DST boundary (regression baseline)', () => {
    // This documents the bug we're avoiding. A pure UTC `+24h` does NOT
    // preserve local clock across a DST transition.
    const start = new Date('2026-04-03T22:00:00Z'); // 09:00 Melbourne AEDT
    const naiveNext = new Date(start.getTime() + 86_400_000);
    // Naive +24h lands at 08:00 the next day (off by one hour).
    assert.equal(formatInTz(naiveNext, 'yyyy-MM-dd HH:mm'), '2026-04-05 08:00');
    // Whereas our DST-safe version lands at 09:00.
    const safeNext = addDays(start, 1);
    assert.equal(formatInTz(safeNext, 'yyyy-MM-dd HH:mm'), '2026-04-05 09:00');
  });

  test('startOfDayInTz at DST boundary returns valid local midnight', () => {
    // At any instant on April 5, 2026, midnight is unambiguous (occurs once
    // before the rollback; the rollback is at 03:00).
    const ref = new Date('2026-04-05T05:00:00Z'); // 15:00 AEST
    const midnight = startOfDayInTz(ref);
    assert.equal(formatInTz(midnight, 'yyyy-MM-dd HH:mm:ss'), '2026-04-05 00:00:00');
  });
});
