import type { VaultItem } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { useSession } from '../../state/session';

/** What the full Vault index gives the gallery: every item, newest first, plus the space figures. */
export interface VaultIndex { items: VaultItem[]; usedBytes: number; quotaBytes: number; maxBytes: number }

const DB_NAME = 'chatward-vault-cache';
const STORE = 'items';
const BATCH = 500;

/**
 * Keeps each server's sealed Vault rows in IndexedDB, so opening the Vault only downloads what is new.
 * The rows are exactly what the server holds (still encrypted), so caching them reveals nothing new.
 */
function openCache(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ['scope', 'id'] });
        store.createIndex('scope', 'scope');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });

async function cached(db: IDBDatabase, scope: string): Promise<Map<string, VaultItem>> {
  const t = db.transaction(STORE, 'readonly');
  const rows = await new Promise<{ id: string; item: VaultItem }[]>((resolve, reject) => {
    const r = t.objectStore(STORE).index('scope').getAll(scope);
    r.onsuccess = () => resolve(r.result as { id: string; item: VaultItem }[]);
    r.onerror = () => reject(r.error);
  });
  return new Map(rows.map((r) => [r.id, r.item]));
}

async function write(db: IDBDatabase, scope: string, add: VaultItem[], remove: string[]): Promise<void> {
  if (!add.length && !remove.length) return;
  const t = db.transaction(STORE, 'readwrite');
  const store = t.objectStore(STORE);
  for (const item of add) store.put({ scope, id: item.id, item });
  for (const id of remove) store.delete([scope, id]);
  await done(t);
}

/**
 * Loads every item in a server's Vault. Returns null when the server is older and has no index; the gallery then
 * pages through the Vault the old way.
 */
export async function loadVaultIndex(serverId: string): Promise<VaultIndex | null> {
  let index: { ids: [string, number][]; usedBytes: number; quotaBytes: number; maxBytes: number };
  try {
    index = await api.get(`/api/servers/${serverId}/vault/index`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.message !== 'server not found') return null;
    throw err;
  }
  const scope = `${useSession.getState().serverUrl}|${serverId}`;
  const db = await openCache();
  const have = db ? await cached(db, scope).catch(() => new Map<string, VaultItem>()) : new Map<string, VaultItem>();
  const wanted = new Set(index.ids.map(([id]) => id));
  const missing = index.ids.map(([id]) => id).filter((id) => !have.has(id));
  const fresh: VaultItem[] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    const { items } = await api.post<{ items: VaultItem[] }>(`/api/servers/${serverId}/vault/items`, { ids: missing.slice(i, i + BATCH) }, 60_000);
    fresh.push(...items);
  }
  for (const item of fresh) have.set(item.id, item);
  const gone = [...have.keys()].filter((id) => !wanted.has(id));
  if (db) await write(db, scope, fresh, gone).catch(() => {});
  db?.close();
  const items = index.ids.map(([id]) => have.get(id)).filter((i): i is VaultItem => !!i);
  return { items, usedBytes: index.usedBytes, quotaBytes: index.quotaBytes, maxBytes: index.maxBytes };
}
