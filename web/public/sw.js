// corral service worker — offline shell + Web Push for the browser-paired phone.
// Shell (html/assets/fonts) is cache-first behind content-hashed names; navigations are
// network-first so a new build lands on the next online open; the herd snapshot endpoints are
// network-first with cache fallback so the last known herd still renders in a tunnel/basement.
// Live sockets (/chat, /events, /ws) and mutations are never intercepted. Push payloads are
// built server-side in webpush.js ({title, body, session}); a tap lands on the session.
const SHELL = 'corral-shell-v1';
const DATA = 'corral-data-v1';
const SNAPSHOTS = new Set(['/api/chat/list', '/api/hosts']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    // typography survives offline; every other cross-origin request passes through untouched
    if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === 'navigate') return e.respondWith(navigate(req));
  if (SNAPSHOTS.has(url.pathname)) return e.respondWith(networkFirst(req));
  if (url.pathname.startsWith('/assets/') || /\.(svg|png|css|js|webmanifest)$/.test(url.pathname)) {
    return e.respondWith(cacheFirst(req));
  }
});

async function navigate(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put('/', res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match('/');
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(DATA)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'corral', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.session ? 'corral-' + d.session : 'corral',   // one notification per session, not a pile
    data: { session: d.session || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.session;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      if (id) wins[0].postMessage({ type: 'open-session', session: id });
      return wins[0].focus();
    }
    return clients.openWindow(id ? '/#session=' + encodeURIComponent(id) : '/');
  })());
});
