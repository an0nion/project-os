/**
 * Unified auth helper.
 *
 * Replaces the six different ad-hoc auth patterns across routes with one
 * `requireAuth(req, { kind })` call. Supported kinds:
 *
 *   - "session"   → validate the `session` cookie against session_tokens table
 *   - "apiSecret" → header `x-api-secret === APP_SECRET` (Slack bot, batch, etc.)
 *   - "cron"      → header `Authorization: Bearer <CRON_SECRET>` (Vercel cron)
 *   - "costLog"   → header `x-api-secret === COST_LOG_SECRET` (with deprecated
 *                   APP_SECRET fallback to ease bot rollout)
 *
 * Returns `{ ok: true, userId? }` or `{ ok: false, reason }`.
 *
 * The session-cookie path is the only one that needs Supabase. All header
 * checks are pure env-var comparisons → cheap, no I/O, edge-runtime safe.
 */

import { supabase } from './supabase.js';

// Lazy-load node:crypto via a runtime-resolved string so webpack/Edge bundling
// for middleware doesn't try to inline it. Middleware only calls requireAuth(),
// never createSession(), so it never executes this branch.
async function nodeCrypto() {
  const mod = 'node:' + 'crypto';
  return import(/* webpackIgnore: true */ mod);
}

const SESSION_COOKIE = 'session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let _costLogFallbackWarned = false;

/**
 * Length-checked string equality. We don't use crypto.timingSafeEqual because
 * this module must also load on the Edge runtime (Next.js middleware), which
 * doesn't ship node:crypto. Risk is negligible for a personal app with a
 * single user and a high-entropy 64-char hex token.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Supports both NextRequest (cookies.get returns { value }) and plain Request
// (cookie header parsing) so the same helper works in middleware, route
// handlers, and the test harness.
function readSessionCookie(req) {
  if (req?.cookies?.get) {
    const c = req.cookies.get(SESSION_COOKIE);
    return typeof c === 'string' ? c : c?.value ?? null;
  }
  const header = req?.headers?.get?.('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export async function lookupSession(token, client = supabase) {
  if (!token) return null;
  const { data, error } = await client
    .from('session_tokens')
    .select('token, user_id, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

export async function createSession(userId = null, client = supabase) {
  const { randomBytes } = await nodeCrypto();
  const token = randomBytes(32).toString('hex'); // 64-char hex
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const { error } = await client.from('session_tokens').insert({
    token,
    user_id: userId,
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw error;
  return { token, expiresAt, maxAge: SESSION_TTL_SECONDS };
}

// Idempotent: silently no-ops on missing/unknown tokens so callers (logout)
// don't need to special-case anonymous requests.
export async function destroySession(token, client = supabase) {
  if (!token) return;
  await client.from('session_tokens').delete().eq('token', token);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    path:     '/',
    maxAge:   SESSION_TTL_SECONDS,
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/**
 * Main entry point. See module docstring for kinds.
 *
 * @param {Request|import('next/server').NextRequest} req
 * @param {{ kind: 'session'|'apiSecret'|'cron'|'costLog', client?: any }} opts
 * @returns {Promise<{ok: true, userId?: string|null} | {ok: false, reason: string}>}
 */
export async function requireAuth(req, { kind, client } = {}) {
  switch (kind) {
    case 'session': {
      const token = readSessionCookie(req);
      if (!token) return { ok: false, reason: 'no_cookie' };
      const row = await lookupSession(token, client);
      if (!row) return { ok: false, reason: 'invalid_or_expired' };
      return { ok: true, userId: row.user_id ?? null };
    }

    case 'apiSecret': {
      const provided = req?.headers?.get?.('x-api-secret');
      const expected = process.env.APP_SECRET;
      if (!expected) return { ok: false, reason: 'server_misconfigured' };
      if (!provided || !safeEqual(provided, expected)) {
        return { ok: false, reason: 'bad_secret' };
      }
      return { ok: true };
    }

    case 'cron': {
      const provided = req?.headers?.get?.('authorization');
      const expected = process.env.CRON_SECRET;
      if (!expected) return { ok: false, reason: 'server_misconfigured' };
      const want = `Bearer ${expected}`;
      if (!provided || !safeEqual(provided, want)) {
        return { ok: false, reason: 'bad_cron_secret' };
      }
      return { ok: true };
    }

    case 'costLog': {
      const provided = req?.headers?.get?.('x-api-secret');
      if (!provided) return { ok: false, reason: 'no_secret' };

      const costSecret = process.env.COST_LOG_SECRET;
      if (costSecret) {
        // Once a dedicated COST_LOG_SECRET is configured, that's the only
        // accepted credential — APP_SECRET no longer grants cost-log access.
        return safeEqual(provided, costSecret)
          ? { ok: true }
          : { ok: false, reason: 'bad_secret' };
      }

      // Transitional fallback — older Slack-bot deploys still send APP_SECRET
      // and COST_LOG_SECRET hasn't been set on this server yet.
      const appSecret = process.env.APP_SECRET;
      if (appSecret && safeEqual(provided, appSecret)) {
        if (!_costLogFallbackWarned) {
          console.warn(
            '[auth] costLog accepted via APP_SECRET fallback. ' +
            'Set COST_LOG_SECRET on this deploy; the fallback will be removed.'
          );
          _costLogFallbackWarned = true;
        }
        return { ok: true };
      }
      return { ok: false, reason: 'bad_secret' };
    }

    default:
      return { ok: false, reason: 'unknown_kind' };
  }
}

/**
 * Convenience: build the standard 401 JSON body that middleware and routes
 * should return on auth failure.
 */
export function unauthorizedBody() {
  return { ok: false, error: { code: 'AUTH', message: 'Unauthorized' } };
}

// Test-only hook to reset deprecation-warning state between cases.
export function _resetForTests() {
  _costLogFallbackWarned = false;
}
