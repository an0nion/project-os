/**
 * Standard JSON envelope helpers for API routes.
 *
 *   ok(data)       → 200 with { ok: true, data }
 *   fail(err, ?s)  → status with { ok: false, error: { code, message, details? } }
 *
 * `fail` understands AppError subclasses (uses .code / .status / .details),
 * and falls back to { code: 'INTERNAL', status: 500 } for plain Error instances.
 *
 * Note: this is additive — frontends still reading `result.foo` may break.
 * Migrate them incrementally to read `result.data.foo`.
 */

import { NextResponse } from 'next/server';

export function ok(data, init) {
  return NextResponse.json({ ok: true, data: data ?? null }, init);
}

export function fail(err, status) {
  const code     = err?.code    || 'INTERNAL';
  const message  = err?.message || 'Internal error';
  const httpCode = status ?? err?.status ?? 500;

  const body = { ok: false, error: { code, message } };
  if (err?.details !== undefined) body.error.details = err.details;

  return NextResponse.json(body, { status: httpCode });
}
