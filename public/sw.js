/* BOSS service worker. It does one thing: show a reminder the server
   pushed, and open BOSS on the right screen when it is clicked. It caches
   nothing and answers no requests, so it cannot serve a stale page. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'BOSS', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'BOSS', {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
    requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: 'boss-open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
