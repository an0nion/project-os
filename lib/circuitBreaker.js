/**
 * Per-provider circuit breaker.
 *
 * States:
 *   - closed    → calls flow normally
 *   - open      → calls short-circuit (throw) for OPEN_DURATION_MS
 *   - half-open → next call is a trial; success closes, failure re-opens
 *
 * Trip condition: FAILURE_THRESHOLD consecutive failures within FAILURE_WINDOW_MS.
 *
 * NOTE: In-memory only. On Vercel serverless, breakers reset between cold-starts and
 *       are not shared across concurrent function instances. The real value is for
 *       the long-running Fly.io Slack bot.
 */

const FAILURE_THRESHOLD  = 3;
const FAILURE_WINDOW_MS  = 60_000;   // 60s window for the 3 consecutive failures
const OPEN_DURATION_MS   = 30_000;   // 30s before half-open trial

/** @type {Map<string, { state: 'closed'|'open'|'half-open', failures: number[], openedAt: number|null }>} */
const breakers = new Map();

function getBreaker(provider) {
  let b = breakers.get(provider);
  if (!b) {
    b = { state: 'closed', failures: [], openedAt: null };
    breakers.set(provider, b);
  }
  return b;
}

/**
 * Returns true if calls to this provider should be skipped (breaker open).
 * Transitions open → half-open if OPEN_DURATION_MS has elapsed.
 */
export function isOpen(provider, now = Date.now()) {
  const b = getBreaker(provider);
  if (b.state === 'open') {
    if (now - b.openedAt >= OPEN_DURATION_MS) {
      b.state = 'half-open';
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Record a successful call. Resets failure history; closes a half-open breaker.
 */
export function recordSuccess(provider) {
  const b = getBreaker(provider);
  b.failures  = [];
  b.openedAt  = null;
  b.state     = 'closed';
}

/**
 * Record a failed call. May open the breaker.
 */
export function recordFailure(provider, now = Date.now()) {
  const b = getBreaker(provider);

  // half-open trial failed → re-open immediately
  if (b.state === 'half-open') {
    b.state    = 'open';
    b.openedAt = now;
    b.failures = [];
    return b;
  }

  // Drop failures outside the rolling window
  b.failures = b.failures.filter(t => now - t < FAILURE_WINDOW_MS);
  b.failures.push(now);

  if (b.failures.length >= FAILURE_THRESHOLD) {
    b.state    = 'open';
    b.openedAt = now;
    b.failures = [];
  }
  return b;
}

/**
 * Wrap a call: if breaker open, throw immediately without invoking fn.
 * Otherwise run fn, then update breaker state from outcome.
 */
export async function withBreaker(provider, fn) {
  if (isOpen(provider)) {
    const e = new Error(`Circuit breaker open for ${provider}`);
    e.code     = 'CIRCUIT_OPEN';
    e.provider = provider;
    throw e;
  }
  try {
    const result = await fn();
    recordSuccess(provider);
    return result;
  } catch (err) {
    recordFailure(provider);
    throw err;
  }
}

/** Test-only: clear all breakers. */
export function _resetAll() {
  breakers.clear();
}

/** Test-only: introspect state. */
export function _getState(provider) {
  return getBreaker(provider).state;
}

export const _config = { FAILURE_THRESHOLD, FAILURE_WINDOW_MS, OPEN_DURATION_MS };
