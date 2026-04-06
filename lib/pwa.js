/**
 * PWA helpers — client-side only.
 * Called from app/layout.jsx on mount.
 */

/** Register the service worker. */
export async function initPWA() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('[PWA] Service worker registered', reg.scope);
    return reg;
  } catch (err) {
    console.warn('[PWA] SW registration failed:', err);
  }
}

/** Request push permission and subscribe, then POST subscription to server. */
export async function requestPushPermission() {
  if (typeof window === 'undefined') return null;
  if (!('Notification' in window)) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const reg = await navigator.serviceWorker.ready;

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    ),
  });

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });

  return subscription;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
