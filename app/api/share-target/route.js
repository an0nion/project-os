/**
 * POST /api/share-target
 * Receives shares from the PWA share target (manifest.json).
 * When the user shares a link from Safari/Chrome to Project OS,
 * this endpoint fires and redirects to the inbox with pre-filled content.
 *
 * The share target spec sends multipart/form-data with title, text, url fields.
 */

import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const formData = await req.formData();
    const title = formData.get('title') || '';
    const text  = formData.get('text')  || '';
    const url   = formData.get('url')   || '';

    // Prefer explicit URL field; fall back to URL in text
    const targetUrl = url || text.match(/https?:\/\/[^\s]+/)?.[0] || '';
    const context   = [title, text].filter(Boolean).join(' ');

    // Redirect to the inbox page with pre-filled params so the user
    // can confirm / see what was captured
    const params = new URLSearchParams();
    if (targetUrl) params.set('url', targetUrl);
    if (context)   params.set('text', context.slice(0, 200));

    return NextResponse.redirect(
      new URL(`/?inbox=1&${params.toString()}`, process.env.APP_URL),
    );
  } catch {
    return NextResponse.redirect(new URL('/', process.env.APP_URL));
  }
}
