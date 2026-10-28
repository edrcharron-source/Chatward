import { useEffect, useState } from 'react';
import type { User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';
import { initials } from './util';

/** Authed avatar: fetches the image bytes and falls back to initials. */
export default function Avatar({ user, size = 32 }: { user: Pick<User, 'displayName' | 'avatarUrl'>; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!user.avatarUrl) return;
    let alive = true;
    let objectUrl: string | null = null;
    fetchObjectUrl(user.avatarUrl)
      .then((u) => {
        if (!alive) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setSrc(u);
      })
      .catch(() => { /* keep initials */ });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user.avatarUrl]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  const shown = user.avatarUrl ? src : null;
  return shown
    ? <img className="avatar" src={shown} alt="" style={style} />
    : <div className="avatar cw-initials" style={style} aria-hidden="true">{initials(user.displayName)}</div>;
}
