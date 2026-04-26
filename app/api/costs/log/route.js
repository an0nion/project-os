/**
 * POST /api/costs/log
 * Internal endpoint — lets the Slack bot log AI call costs without importing
 * supabase directly (which crashes on startup if SUPABASE_URL isn't in VM .env).
 *
 * Auth: x-api-secret header validated against COST_LOG_SECRET (preferred).
 * Older bot deploys still send APP_SECRET — lib/auth.js accepts it as a
 * deprecated fallback and emits a one-time warning. Once VM .env has been
 * rotated to COST_LOG_SECRET, the fallback can be removed.
 *
 * Body: { modelKey, usage: { input_tokens, output_tokens }, reason?, projectKey? }
 */

import { NextResponse }                  from 'next/server';
import { logCost }                       from '../../../../lib/costTracker.js';
import { requireAuth, unauthorizedBody } from '../../../../lib/auth.js';

export async function POST(req) {
  const auth = await requireAuth(req, { kind: 'costLog' });
  if (!auth.ok) {
    return NextResponse.json(unauthorizedBody(), { status: 401 });
  }

  const { modelKey, usage, reason, projectKey } = await req.json();
  if (!modelKey || !usage) {
    return NextResponse.json({ error: 'modelKey and usage required' }, { status: 400 });
  }

  await logCost(modelKey, usage, { reason, projectKey });
  return NextResponse.json({ ok: true });
}
