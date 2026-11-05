// Chatward web app service worker. It makes the app installable and keeps the app's own files (the page, scripts,
// styles and icons) cached so it opens fast. It never caches the API, the chat socket, uploads or voice: those are
// always fetched live, and encrypted messages are never stored here.
const CACHE = 'chatward-shell-v1';
const LIVE = /^\/(api|ws|rtc|updates)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || LIVE.test(url.pathname)) return;
  // The page itself: network first, so a server update shows on the next open; the cached copy only when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/')),
    );
    return;
  }
  // Built files have a content hash in their name, so a cached copy is always the right one.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
