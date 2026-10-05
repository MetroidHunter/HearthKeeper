// Service worker (design §15.2): app shell + last Home snapshot for instant open and read-only offline; web push.
// Security: auth endpoints are never cached; only successful API responses are kept and they are wiped on logout;
// the shell is network-first so a deploy reaches installed phones; the cache name is versioned.
const VERSION = 'hk-v2';
const SHELL = ['/', '/index.html'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', (e) => { if (e.data === 'logout') e.waitUntil(caches.delete(VERSION)); }); // drop every cached response (including the last Home snapshot)
const put = (req, r) => { if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; };
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/ingest') || u.pathname.startsWith('/auth') || u.pathname === '/healthz') return; // network only: never cache identity or capture
  if (u.pathname.startsWith('/api/')) { // network first; fall back to the last good snapshot (read-only offline)
    e.respondWith(fetch(e.request).then((r) => put(e.request, r)).catch(() => caches.match(e.request).then((hit) => hit || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  if (u.pathname.startsWith('/assets/')) { // hashed filenames: cache-first is safe
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => put(e.request, r))));
    return;
  }
  e.respondWith(fetch(e.request).then((r) => put(e.request, r)).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))); // shell: network first
});
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'HearthKeeper', body: 'Something needs you' };
  if (d.close) { e.waitUntil(self.registration.getNotifications({ tag: d.tag }).then((ns) => ns.forEach((n) => n.close()))); return; }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, data: d, actions: d.actions || [], tag: d.tag }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (e.action && d.id) { // one-tap answer from the notification itself
    e.waitUntil(fetch(`/api/transactions/${d.id}/categorize`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify({ categoryId: Number(e.action) }) }));
  } else e.waitUntil(self.clients.openWindow(d.url || '/#/'));
});
