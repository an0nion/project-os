/**
 * POST /api/push/subscribe
 * Store a Web Push subscription for a user.
 * Called by lib/pwa.js after the browser subscribes via pushManager.subscribe().
 *
 * Body: PushSubscription JSON (endpoint, keys.auth, keys.p256dh)
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function POST(req) {
  const subscription = await req.json();

  if (!subscription?.endpoint) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
  }

  // Upsert — if the same endpoint re-subscribes, update its keys
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      { endpoint: subscription.endpoint, subscription },
      { onConflict: 'endpoint' },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
