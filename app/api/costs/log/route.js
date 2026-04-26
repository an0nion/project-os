/**
 * POST /api/costs/log
 * Internal endpoint — lets the Slack bot log AI call costs without importing
 * supabase directly (which crashes on startup if SUPABASE_URL isn't in VM .env).
 *
 * Auth: x-api-secret header validated via lib/auth.js (kind 'costLog').
 * Older bot deploys still send APP_SECRET — lib/auth.js accepts it as a
 * deprecated fallback and emits a one-time warning. Once VM .env has been
 * rotated to COST_LOG_SECRET, the fallback can be removed.
 *
 * Body: see lib/schemas.js#CostsLogPost
 */

import { logCost }      from '../../../../lib/costTracker.js';
import { requireAuth }  from '../../../../lib/auth.js';
import { ok, fail }     from '../../../../lib/apiResponse.js';
import { CostsLogPost } from '../../../../lib/schemas.js';
import { ValidationError, AuthError } from '../../../../lib/errors.js';
import { log }          from '../../../../lib/log.js';

export async function POST(req) {
  try {
    const auth = await requireAuth(req, { kind: 'costLog' });
    if (!auth.ok) throw new AuthError(auth.reason ?? 'Unauthorized');

    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = CostsLogPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { modelKey, usage, reason, projectKey } = parsed.data;

    await logCost(modelKey, usage, { reason, projectKey });
    return ok({ ok: true });
  } catch (err) {
    log.error('costs:log', 'failed', { err: err.message });
    return fail(err);
  }
}
