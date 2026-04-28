import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_TZ, nowInTz, formatInTz, addDays, parseAbsoluteIso, todayIsoDate, startOfDayInTz,
} from '../lib/timezone.js';

describe('timezone helpers', () => {
  let originalTz;
  before(() => { originalTz = process.env.APP_TIMEZONE; });
  after(()  => { process.env.APP_TIMEZONE = originalTz; });

  test('APP_TZ defaults to Australia/Melbourne', () => {
    delete process.env.APP_TIMEZONE;
    assert.equal(APP_TZ(), 'Australia/Melbourne');
  });

  test('APP_TZ honors APP_TIMEZONE env var', () => {
    process.env.APP_TIMEZONE = 'UTC';
    assert.equal(APP_TZ(), 'UTC');
  });

  test('formatInTz formats a known instant', () => {
    process.env.APP_TIMEZONE = 'UTC';
    const d = new Date('2026-04-27T15:30:00Z');
    assert.equal(formatInTz(d, 'yyyy-MM-dd HH:mm'), '2026-04-27 15:30');
  });

  test('addDays moves forward by N calendar days (non-DST window)', () => {
    process.env.APP_TIMEZONE = 'UTC';
    const start = new Date('2026-06-15T12:00:00Z');
    const after5 = addDays(start, 5);
    assert.equal(formatInTz(after5, 'yyyy-MM-dd'), '2026-06-20');
  });

  test('addDays handles negative N (backwards)', () => {
    process.env.APP_TIMEZONE = 'UTC';
    const start = new Date('2026-06-15T12:00:00Z');
    assert.equal(formatInTz(addDays(start, -3), 'yyyy-MM-dd'), '2026-06-12');
  });

  test('parseAbsoluteIso returns a UTC Date from ISO string', () => {
    const d = parseAbsoluteIso('2026-04-27T00:00:00Z');
    assert.equal(d.toISOString(), '2026-04-27T00:00:00.000Z');
  });

  test('todayIsoDate returns yyyy-MM-dd', () => {
    process.env.APP_TIMEZONE = 'UTC';
    const today = todayIsoDate();
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('nowInTz returns a Date object', () => {
    const n = nowInTz();
    assert.ok(n instanceof Date);
    assert.ok(!Number.isNaN(n.getTime()));
  });

  test('startOfDayInTz produces midnight in the configured zone', () => {
    process.env.APP_TIMEZONE = 'Australia/Melbourne';
    // June 15, 2026 — AEST (UTC+10), no DST.
    const ref = new Date('2026-06-15T05:00:00Z'); // 15:00 Melbourne
    const midnight = startOfDayInTz(ref);
    assert.equal(formatInTz(midnight, 'yyyy-MM-dd HH:mm:ss'), '2026-06-15 00:00:00');
  });
});
