// Service worker (design §15.2): caches the app shell and the last Home snapshot so the app opens instantly and works read-only offline.
// Answers made offline are queued in IndexedDB-free fashion via the page (see api.ts); this worker also receives web push.
const CACHE = 'hk-v1';
const SHELL = ['/', '/index.html'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/ingest')) return;
  if (u.pathname.startsWith('/api/')) {
    // network first, fall back to the last snapshot (read-only offline)
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
});
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'HearthKeeper', body: 'Something needs you' };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, data: d, actions: d.actions || [], tag: d.tag }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (e.action && d.id) {
    // one-tap answer from the notification itself
    e.waitUntil(fetch(`/api/transactions/${d.id}/categorize`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify({ categoryId: Number(e.action) }) }));
  } else e.waitUntil(self.clients.openWindow(d.url || '/#/inbox'));
});
