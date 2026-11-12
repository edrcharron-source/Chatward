// Chatward web app service worker. It makes the app installable and keeps the app's own files (the page, scripts,
// styles and icons) cached so it opens fast. It never caches the API, the chat socket, uploads or voice: those are
// always fetched live, and encrypted messages are never stored here.
const CACHE = 'chatward-shell-v2';
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

// Notifications (Web Push). For a chat message the server adds the message still end-to-end encrypted ("locked"); this
// opens it with the chat key the app keeps on this phone and shows the text. The text is never sent to the server in the
// clear. If the key isn't here (the app hasn't been opened since the chat key changed) the server's wording is shown.
const SECURE_DB = 'chatward-secure';
const PUSH_ACCOUNT = 'push.account';
const PREVIEW_MAX = 180;

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Same storage as the app's secure store (src/renderer/src/web/bridge.ts): values sealed with a browser-held key.
async function secureGet(db, wrapKey, name) {
  const sealed = await idbGet(db, `v:${name}`);
  if (!sealed) return null;
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, wrapKey, sealed.data);
  return new TextDecoder().decode(plain);
}

function openSecureDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SECURE_DB);
    // Never create the database here; only the app does that.
    req.onupgradeneeded = () => { req.transaction.abort(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Mirrors decryptMessage in src/renderer/src/crypto/index.ts. Returns the message payload, or null. */
async function openLocked(locked) {
  const db = await openSecureDb();
  try {
    const wrapKey = await idbGet(db, '__wrap_key__');
    if (!wrapKey) return null;
    const account = await secureGet(db, wrapKey, PUSH_ACCOUNT);
    if (!account) return null;
    const vaultRaw = await secureGet(db, wrapKey, `crypto.vault.v2|${account}`);
    const raw = vaultRaw && JSON.parse(vaultRaw).channels?.[locked.channelId]?.[String(locked.keyVersion)];
    if (!raw) return null;
    const key = await crypto.subtle.importKey('raw', b64bytes(raw), 'AES-GCM', false, ['decrypt']);
    const sealed = b64bytes(locked.ciphertext);
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: sealed.slice(0, 12),
      additionalData: new TextEncoder().encode(`${locked.channelId}|${locked.keyVersion}|${locked.authorId}`),
    }, key, sealed.slice(12));
    const payload = JSON.parse(new TextDecoder().decode(plain));
    return typeof payload?.text === 'string' ? payload : null;
  } finally {
    db.close();
  }
}

function previewOf(author, payload) {
  const text = payload.text.replace(/\s+/g, ' ').trim();
  if (text) return `${author}: ${text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text}`;
  if (payload.gif) return `${author} sent a GIF`;
  const files = [...(payload.attachments || []), ...(payload.vault || [])];
  const kinds = new Set(files.map((f) => (/^image\//.test(f.mime || '') ? 'photo' : /^video\//.test(f.mime || '') ? 'video' : 'file')));
  const kind = kinds.size === 1 ? [...kinds][0] : 'file';
  if (files.length === 1) return `${author} sent a ${kind}`;
  if (files.length) return `${author} sent ${files.length} ${kind}s`;
  return null;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    let body = data.body || '';
    if (data.locked && typeof data.locked.ciphertext === 'string') {
      try {
        const payload = await openLocked(data.locked);
        const preview = payload && previewOf(String(data.locked.author || 'Someone'), payload);
        if (preview) body = preview;
      } catch { /* keep the server's wording */ }
    }
    await self.registration.showNotification(data.title || 'Chatward', {
      body,
      tag: data.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    });
    // The number on the app icon: how many notifications are waiting. The app clears it when opened.
    try {
      const shown = await self.registration.getNotifications();
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(shown.length || 1);
    } catch { /* badges not supported */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
