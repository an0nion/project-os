/**
 * POST /api/costs/log
 * Internal endpoint — lets the Slack bot log AI call costs without importing
 * supabase directly (which crashes on startup if SUPABASE_URL isn't in VM .env).
 *
 * Body: { modelKey, usage: { input_tokens, output_tokens }, reason?, projectKey? }
 */

import { NextResponse } from 'next/server';
import { logCost }      from '../../../../lib/costTracker.js';

export async function POST(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { modelKey, usage, reason, projectKey } = await req.json();
  if (!modelKey || !usage) {
    return NextResponse.json({ error: 'modelKey and usage required' }, { status: 400 });
  }

  await logCost(modelKey, usage, { reason, projectKey });
  return NextResponse.json({ ok: true });
}
