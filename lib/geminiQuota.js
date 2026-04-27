/**
 * Persistent Gemini free-tier quota tracker.
 *
 * Previously `_geminiCallsToday` was an in-process variable in multiModelClient.js.
 * PM2 restarts zeroed it mid-day, causing over-use until a 429 arrived.
 *
 * This module persists the count to Supabase via the Vercel /api/counters proxy
 * (same pattern as vmCostLogger.js — no direct Supabase import on the VM).
 *
 * Race-fix: incrementQuota() is async and awaited by multiModelClient. Concurrent
 * callers are serialized through a single in-flight promise chain so only one POST
 * is in flight at a time. The remote performs an atomic UPDATE ... RETURNING value,
 * so the local count is rehydrated from the authoritative remote value.
 *
 * Public API:
 *   loadQuota(appUrl, secret)       — call once at bot startup
 *   quotaRemaining()                — sync read, used in callModelWithFallback
 *   incrementQuota(appUrl, secret)  — async, await before issuing the Gemini call
 */

const GEMINI_FREE_LIMIT = 1000;
const COUNTER_KEY       = 'gemini_calls_today';
const RETRY_DELAYS_MS   = [100, 300, 1000];   // 3 retries, exponential

let _count = 0;
let _date  = null;   // 'YYYY-MM-DD' in UTC — the date _count refers to

// Tail of the in-flight serialization chain. Each new incrementQuota() chains
// onto this promise so only one POST runs at a time.
let _inflight = Promise.resolve();

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
 * Increment the counter on the remote (atomic) and update the local cache.
 *
 * Concurrent calls are serialized via a single in-flight chain so only one POST
 * is in flight at a time. The remote performs an atomic UPDATE and returns the
 * authoritative count; we use it to rehydrate _count.
 *
 * Up to 3 retries with exponential backoff (100ms, 300ms, 1s). On all-retry
 * failure we log critical and pin _count to 95% of the limit so subsequent
 * `quotaRemaining()` reads return a small value, causing the caller to fall back
 * to DeepSeek.
 *
 * @returns {Promise<{remaining:number}>}
 */
export function incrementQuota(appUrl, secret) {
  // Day rollover guard for the local view.
  if (_date !== todayUtc()) { _count = 0; _date = todayUtc(); }

  // No persistence target — just bump local and return.
  if (!appUrl || !secret) {
    _count++;
    return Promise.resolve({ remaining: GEMINI_FREE_LIMIT - _count });
  }

  // Chain onto the in-flight tail to serialize concurrent calls.
  const next = _inflight.then(() => _doIncrement(appUrl, secret));
  // Don't let one failure poison the chain for subsequent callers.
  _inflight = next.catch(() => {});
  return next;
}

async function _doIncrement(appUrl, secret) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${appUrl}/api/counters`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
        body:    JSON.stringify({ key: COUNTER_KEY, delta: 1, meta: { date: _date } }),
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        // Don't retry permanent client errors (auth, bad request) — only transient ones.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } else {
        const data = await res.json().catch(() => ({}));
        if (typeof data.value === 'number') {
          _count = data.value;
        } else {
          _count++;
        }
        return { remaining: GEMINI_FREE_LIMIT - _count };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await _sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  // All retries failed — pin remaining low so caller falls back to DeepSeek.
  console.error('[geminiQuota:increment] CRITICAL — persistence failed:', lastErr?.message);
  const safeFloor = Math.floor(GEMINI_FREE_LIMIT * 0.95);
  if (_count < safeFloor) _count = safeFloor;
  return { remaining: GEMINI_FREE_LIMIT - _count };
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
