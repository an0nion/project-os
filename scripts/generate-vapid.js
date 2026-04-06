/**
 * One-time VAPID key generation.
 * Run: npm run vapid
 *
 * Paste the output into .env.local:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *
 * Do NOT re-run this after deployment — existing push subscriptions
 * are tied to the public key. Regenerating breaks them.
 */

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

console.log('\n✅ VAPID keys generated — paste into .env.local:\n');
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('\n⚠️  Keep the private key secret. Do NOT commit .env.local.\n');
