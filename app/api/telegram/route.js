/**
 * POST /api/telegram
 * Optional Telegram webhook handler.
 * Only needed if you want two-way Telegram interaction (not just notifications).
 * For outbound-only notifications, this file is never called.
 *
 * Setup: curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<APP_URL>/api/telegram"
 */

import { NextResponse } from 'next/server';

export async function POST(req) {
  const update = await req.json();

  // Echo received messages (placeholder — expand for real two-way interaction)
  const msg = update?.message;
  if (!msg) return NextResponse.json({ ok: true });

  const chatId = msg.chat?.id;
  const text   = msg.text ?? '';

  console.log(`[Telegram] Message from ${chatId}: ${text}`);

  // For now, just acknowledge — notifications are push-only
  return NextResponse.json({ ok: true });
}
