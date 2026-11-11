import { useEffect, useState } from 'react';
import { fetchObjectUrl } from './http';

// Avatar and banner paths carry a version, so a new upload gets a new path and cached bytes never go stale.
// Kept for the whole session so a profile card can show its pictures on the first frame.
const loaded = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** The image's object URL if it has already been fetched, else null. */
export function cachedImageUrl(path: string | null | undefined): string | null {
  return path ? loaded.get(path) ?? null : null;
}

/** Fetches an authed image once and shares its object URL. */
export function loadImageUrl(path: string): Promise<string> {
  const done = loaded.get(path);
  if (done) return Promise.resolve(done);
  let p = pending.get(path);
  if (!p) {
    p = fetchObjectUrl(path).then((u) => { loaded.set(path, u); return u; });
    p.catch(() => undefined).finally(() => pending.delete(path));
    pending.set(path, p);
  }
  return p;
}

/** Starts fetching images in the background, e.g. when the pointer moves over a profile. */
export function preloadImages(...paths: (string | null | undefined)[]): void {
  for (const path of paths) if (path) void loadImageUrl(path).catch(() => undefined);
}

/** Object URL for an authed image; null while loading, when unset, or on failure. */
export function useCachedImage(path: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => cachedImageUrl(path));
  useEffect(() => {
    if (!path) { setUrl(null); return; }
    const hit = cachedImageUrl(path);
    setUrl(hit);
    if (hit) return;
    let alive = true;
    loadImageUrl(path).then((u) => { if (alive) setUrl(u); }, () => undefined);
    return () => { alive = false; };
  }, [path]);
  return path ? url : null;
}
