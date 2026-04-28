/**
 * DST-safe timezone helpers.
 *
 * Single-user app pinned to APP_TIMEZONE (default 'Australia/Melbourne').
 * Existing code does manual offset math (`AEST_OFFSET_MS = 10*60*60*1000`)
 * which is silently wrong half the year (AEDT = UTC+11). This module is the
 * one place that knows about timezones; everything else calls into it.
 *
 * `addDays` uses zoned arithmetic so it preserves *local clock time* across
 * DST boundaries — crucial because cron jobs key off "midnight local".
 */

import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays as fnsAddDays, parseISO } from 'date-fns';

/**
 * Default IANA timezone when APP_TIMEZONE env var is unset.
 * Centralised here so the literal lives in exactly one place — the grep gate
 * in CI rejects this string anywhere else in slack/, app/, or lib/.
 */
export const DEFAULT_APP_TZ = 'Australia/Melbourne';

/**
 * Resolve the active app timezone. Reads `process.env.APP_TIMEZONE` each call
 * so test overrides take effect mid-process; falls back to Australia/Melbourne.
 *
 * @returns {string} IANA tz identifier
 */
export function APP_TZ() {
  return process.env.APP_TIMEZONE || DEFAULT_APP_TZ;
}

/**
 * Current wall-clock time in the app timezone, expressed as a `Date`.
 * NOTE: the returned Date's UTC fields encode the LOCAL (zoned) time —
 * use `formatInTz` for display, not `.toISOString()`.
 *
 * @returns {Date}
 */
export function nowInTz() {
  return toZonedTime(new Date(), APP_TZ());
}

/**
 * Format a Date in the app timezone using a date-fns format string.
 *
 * @param {Date|number|string} date
 * @param {string} fmt e.g. 'yyyy-MM-dd', 'yyyy-MM-dd HH:mm'
 * @returns {string}
 */
export function formatInTz(date, fmt) {
  return formatInTimeZone(date, APP_TZ(), fmt);
}

/**
 * DST-safe: move `date` forward by `n` calendar days, preserving the local
 * clock time (e.g. 09:00 stays 09:00 even when crossing AEDT↔AEST).
 *
 * @param {Date|number|string} date
 * @param {number} n
 * @returns {Date} a UTC Date whose zoned time equals input + n days
 */
export function addDays(date, n) {
  const tz = APP_TZ();
  const zoned = toZonedTime(date, tz);
  const movedZoned = fnsAddDays(zoned, n);
  return fromZonedTime(movedZoned, tz);
}

/**
 * Strict ISO-8601 parser. Returns a UTC `Date`. Wrap of date-fns `parseISO`.
 *
 * @param {string} str
 * @returns {Date}
 */
export function parseAbsoluteIso(str) {
  return parseISO(str);
}

/**
 * Today's date as 'yyyy-MM-dd' in the app timezone.
 * @returns {string}
 */
export function todayIsoDate() {
  return formatInTz(new Date(), 'yyyy-MM-dd');
}

/**
 * UTC `Date` that represents midnight (00:00:00) of `date`'s calendar day in
 * the app timezone. Replaces the manual `AEST_OFFSET_MS` arithmetic in cron
 * handlers — works correctly across DST boundaries.
 *
 * @param {Date|number|string} [date=new Date()]
 * @returns {Date}
 */
export function startOfDayInTz(date = new Date()) {
  const tz = APP_TZ();
  const dateStr = formatInTimeZone(date, tz, 'yyyy-MM-dd');
  return fromZonedTime(`${dateStr}T00:00:00`, tz);
}
