import type { UpdateStatus } from '@chatward/shared';
import type { ChatwardApi } from '../../../preload/index';

/**
 * The web app (Chatward opened in a browser, or added to an iPhone home screen) has no Electron preload, so this gives
 * the page the same window.chatward the desktop app has, built from what a browser offers.
 *
 * Secure storage: the desktop app encrypts its keys with Windows' safeStorage. Here every value is encrypted with an
 * AES-GCM key that is created inside the browser as non-extractable and kept in IndexedDB, so the key's bytes can never
 * be read by page script, only used. The encrypted values sit in the same database.
 */

const DB_NAME = 'chatward-secure';
const STORE = 'kv';
const KEY_ID = '__wrap_key__';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open browser storage'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Browser storage failed'));
  });
}

let ready: Promise<{ db: IDBDatabase; key: CryptoKey }> | null = null;

function storage(): Promise<{ db: IDBDatabase; key: CryptoKey }> {
  ready ??= (async () => {
    const db = await openDb();
    let key = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get(KEY_ID));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await tx(db, 'readwrite', (s) => s.put(key, KEY_ID));
    }
    // Ask the browser not to clear this site's storage under pressure. Losing it means losing this device's keys.
    void navigator.storage?.persist?.().catch(() => false);
    return { db, key };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

interface Sealed { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }

const secureStore: ChatwardApi['secureStore'] = {
  async get(name) {
    const { db, key } = await storage();
    const sealed = await tx<Sealed | undefined>(db, 'readonly', (s) => s.get(`v:${name}`));
    if (!sealed) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
    return new TextDecoder().decode(plain);
  },
  async set(name, value) {
    const { db, key } = await storage();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    await tx(db, 'readwrite', (s) => s.put({ iv, data } satisfies Sealed, `v:${name}`));
  },
};

/** True when the browser can share a screen (desktop browsers). iPhone Safari cannot. */
export function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

const idle: UpdateStatus = { state: 'none' };

/** The browser's version of window.chatward. Features that need the desktop app (Spotify, window controls, GIF clipboard) are left out, and the page already hides them when they are missing. */
const webApi = {
  secureStore,
  // The browser shows its own picker when the share starts, so there is one choice here and selecting it does nothing.
  getScreenSources: async () => (canShareScreen() ? [{ id: 'browser', name: 'Choose in browser', thumbnail: '', appIcon: null, isScreen: true }] : []),
  selectScreenSource: async () => {},
  flashWindow: () => {},
  updates: {
    // The web app is served by the server itself, so it is always the server's version and never needs an installer.
    getVersion: async () => __CHATWARD_BUILD__.commit,  // not compared: checkServerVersion skips the web app
    getStatus: async () => idle,
    check: async () => {},
    install: async () => {},
    onStatus: () => () => {},
  },
  demo: {
    linkPreview: async () => ({ status: 503, body: null }),
    gifs: async () => null,
  },
  // The web app only ever talks to the server it was loaded from, so there is nothing to allow and no reload.
  server: { allow: async () => false },
} as unknown as ChatwardApi;

export function installWebBridge(): void {
  if (!window.chatward) (window as { chatward?: ChatwardApi }).chatward = webApi;
}

/** Registers the service worker that makes the web app installable and opens it offline to a "can't reach" screen. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw]', e)); });
}
