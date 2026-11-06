import type { User } from '@chatward/shared';
import { useCachedImage } from '../../api/imageCache';
import { initials } from './util';

/** Authed avatar: shows the uploaded picture, or initials when there is none. */
export default function Avatar({ user, size = 32 }: { user: Pick<User, 'displayName' | 'avatarUrl'>; size?: number }) {
  const src = useCachedImage(user.avatarUrl);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (src) return <img className="avatar" src={src} alt="" style={style} />;
  // While an uploaded picture is still loading, show a plain circle rather than the initials it is about to replace.
  return <div className="avatar cw-initials" style={style} aria-hidden="true">{user.avatarUrl ? null : initials(user.displayName)}</div>;
}
