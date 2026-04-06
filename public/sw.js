/**
 * Service Worker — Project OS
 *
 * Responsibilities:
 *   1. Cache app shell for offline access (/ and /dashboard)
 *   2. Network-first strategy for pages; cache as fallback
 *   3. Handle Web Push notifications
 *   4. Handle notification clicks (open correct page in app)
 */

const CACHE_NAME  = 'project-os-v1';
const SHELL_URLS  = ['/', '/manifest.json'];

// ── Install: cache the app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)),
  );
  self.skipWaiting(); // Activate immediately
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// ── Fetch: network-first, fall back to cache ─────────────────────────────────
self.addEventListener('fetch', event => {
  // Only intercept GET requests for navigable pages (not API calls)
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone and cache fresh responses
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};

  event.waitUntil(
    self.registration.showNotification(data.title || 'Project OS', {
      body:    data.body    || '',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag     || 'default',
      data:    { url: data.url || '/' },
      actions: data.actions || [],
    }),
  );
});

// ── Notification click: open the correct page ────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Re-focus an existing window if the app is already open
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    }),
  );
});
