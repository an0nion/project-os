/**
 * App-wide password protection.
 *
 * - All pages and API routes require either:
 *     a) a valid `session` cookie (set after correct password)
 *     b) a valid `x-api-secret` header (for Slack bot / cron callers)
 * - /api/login is always public (the login endpoint itself)
 * - Static assets (_next/*) are always public
 */

import { NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  '/api/login',
  '/login',
];

export function middleware(req) {
  const { pathname } = req.nextUrl;

  // Always allow static assets and public paths
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icons') ||
    pathname.startsWith('/manifest') ||
    PUBLIC_PATHS.includes(pathname)
  ) {
    return NextResponse.next();
  }

  // Allow API calls with the correct secret header (Slack bot, cron, etc.)
  const apiSecret = req.headers.get('x-api-secret');
  if (apiSecret && apiSecret === process.env.APP_SECRET) {
    return NextResponse.next();
  }

  // Allow requests with valid session cookie
  const session = req.cookies.get('session')?.value;
  if (session && session === process.env.APP_SECRET) {
    return NextResponse.next();
  }

  // API routes: return 401 JSON
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Pages: redirect to login
  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
