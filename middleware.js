/**
 * App-wide auth gate.
 *
 * Routes through `lib/auth.js` so the middleware uses the same checks the
 * route handlers do. For /api/* paths we accept EITHER a valid session
 * cookie (browser users) OR a valid `x-api-secret` header (Slack bot, cron).
 * For page paths we require a session cookie and otherwise redirect to /login.
 *
 * Public paths: /api/login, /login, static assets.
 */

import { NextResponse } from 'next/server';
import { requireAuth, unauthorizedBody } from './lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/api/login',
  '/api/logout',
  '/login',
]);

function isPublicAsset(pathname) {
  return (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icons') ||
    pathname.startsWith('/manifest')
  );
}

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  if (isPublicAsset(pathname) || PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const isApi = pathname.startsWith('/api/');

  // API routes: accept apiSecret header OR session cookie.
  if (isApi) {
    const headerCheck = await requireAuth(req, { kind: 'apiSecret' });
    if (headerCheck.ok) return NextResponse.next();

    const sessionCheck = await requireAuth(req, { kind: 'session' });
    if (sessionCheck.ok) return NextResponse.next();

    return NextResponse.json(unauthorizedBody(), { status: 401 });
  }

  // Page routes: must have a valid session cookie.
  const sessionCheck = await requireAuth(req, { kind: 'session' });
  if (sessionCheck.ok) return NextResponse.next();

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
