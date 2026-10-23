// Push service worker: shows system notifications and opens the related page of the app.
//
// It is registered on its own scope (/push-sw-scope/, see src/push/browser.ts), never as the page
// controller, so it cannot interfere with caching or with the app's own service worker (the PWA
// one, scope "/"). It only reacts to `push` and `notificationclick`.
//
// Payload (JSON, from the server): { title, body, url, tag }. `url` is an app path or null.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Same-origin path only: anything else (another site, a javascript: URL) opens the app. */
function safeTarget(raw) {
  try {
    const url = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
    if (url.origin !== self.location.origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title ? data.title : 'orch';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icon-192.png',
      badge: '/icon-monochrome-512.png',
      data: { url: safeTarget(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(target);
          } catch {
            // an uncontrolled client may refuse: fall through to a new window below
            continue;
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
