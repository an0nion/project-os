/**
 * Persistent Gemini free-tier quota tracker.
 *
 * Previously `_geminiCallsToday` was an in-process variable in multiModelClient.js.
 * PM2 restarts zeroed it mid-day, causing over-use until a 429 arrived.
 *
 * This module persists the count to Supabase via the Vercel /api/counters proxy
 * (same pattern as vmCostLogger.js — no direct Supabase import on the VM).
 *
 * Public API:
 *   loadQuota(appUrl, secret)    — call once at bot startup
 *   quotaRemaining()             — sync read, used in callModelWithFallback
 *   incrementQuota(appUrl, secret) — fire-and-forget, called after each Google call
 */

const GEMINI_FREE_LIMIT = 1000;
const COUNTER_KEY       = 'gemini_calls_today';

let _count = 0;
let _date  = null;   // 'YYYY-MM-DD' in UTC — the date _count refers to

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load the persisted quota count from Supabase on bot startup.
 * If the stored date differs from today, the counter is treated as zero.
 */
export async function loadQuota(appUrl, secret) {
  if (!appUrl || !secret) return;
  try {
    const res = await fetch(`${appUrl}/api/counters?key=${COUNTER_KEY}`, {
      headers: { 'x-api-secret': secret },
    });
    if (res.ok) {
      const { value, meta } = await res.json();
      const storedDate = meta?.date ?? null;
      if (storedDate === todayUtc()) {
        _count = value ?? 0;
        _date  = storedDate;
        console.log(`[geminiQuota] loaded ${_count} calls for ${_date}`);
      } else {
        // New day — reset
        _count = 0;
        _date  = todayUtc();
        console.log(`[geminiQuota] new day, reset to 0`);
        await _resetRemote(appUrl, secret);
      }
    }
  } catch (err) {
    console.error('[geminiQuota:load]', err.message);
  }
}

/**
 * Returns how many Gemini calls remain today.
 * Handles local day rollover (bot running past UTC midnight without a restart).
 */
export function quotaRemaining() {
  if (_date !== todayUtc()) {
    _count = 0;
    _date  = todayUtc();
  }
  return GEMINI_FREE_LIMIT - _count;
}

/**
 * Increment the counter locally (immediate) and persist async (fire-and-forget).
 */
export function incrementQuota(appUrl, secret) {
  if (_date !== todayUtc()) { _count = 0; _date = todayUtc(); }
  _count++;
  if (!appUrl || !secret) return;
  fetch(`${appUrl}/api/counters/increment`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
    body:    JSON.stringify({ key: COUNTER_KEY, meta: { date: _date } }),
  }).catch(err => console.error('[geminiQuota:increment]', err.message));
}

async function _resetRemote(appUrl, secret) {
  try {
    await fetch(`${appUrl}/api/counters/reset`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
      body:    JSON.stringify({ key: COUNTER_KEY, value: 0, meta: { date: todayUtc() } }),
    });
  } catch (err) {
    console.error('[geminiQuota:reset]', err.message);
  }
}
