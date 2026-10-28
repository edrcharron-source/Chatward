import { useEffect, useState } from 'react';
import type { User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';

// Avatars need the auth header, so they are fetched once and shared by every message from that user.
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; src: Promise<string> }>();
// path -> how many mounted Avatars show its object URL. A URL is only revoked when nothing shows it.
const users = new Map<string, number>();

// Frees the object URLs of expired entries that no mounted Avatar is showing.
function evictExpired() {
  const now = Date.now();
  for (const [path, hit] of cache) {
    if (now - hit.at < TTL_MS || users.has(path)) continue;
    cache.delete(path);
    void hit.src.then((url) => URL.revokeObjectURL(url), () => undefined);
  }
}

function avatarSrc(path: string): Promise<string> {
  evictExpired();
  // A mounted Avatar keeps its entry even past the TTL, so the URL it shows stays valid.
  const hit = cache.get(path);
  if (hit && (Date.now() - hit.at < TTL_MS || users.has(path))) return hit.src;
  const src = fetchObjectUrl(path);
  cache.set(path, { at: Date.now(), src });
  src.catch(() => cache.delete(path));
  return src;
}

function acquire(path: string) {
  users.set(path, (users.get(path) ?? 0) + 1);
}

function release(path: string) {
  const left = (users.get(path) ?? 1) - 1;
  if (left > 0) {
    users.set(path, left);
    return;
  }
  users.delete(path);
  evictExpired();
}

export default function Avatar({ user, size = 36 }: { user?: User; size?: number }) {
  const path = user?.avatarUrl ?? null;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      return;
    }
    let alive = true;
    acquire(path);
    avatarSrc(path).then(
      (u) => { if (alive) setSrc(u); },
      () => { if (alive) setSrc(null); },
    );
    return () => {
      alive = false;
      release(path);
    };
  }, [path]);

  const style = { width: size, height: size };
  if (src) return <img className="avatar cv-avatar" src={src} alt="" style={style} />;
  return (
    <div className="avatar cv-avatar cv-avatar-fallback" style={style} aria-hidden>
      {(user?.displayName ?? '?').slice(0, 1).toUpperCase()}
    </div>
  );
}
