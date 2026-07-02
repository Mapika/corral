// corral service worker — offline shell for the browser-paired phone.
// Shell (html/assets/fonts) is cache-first behind content-hashed names; navigations are
// network-first so a new build lands on the next online open; the herd snapshot endpoints are
// network-first with cache fallback so the last known herd still renders in a tunnel/basement.
// Live sockets (/chat, /events, /ws) and mutations are never intercepted.
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
