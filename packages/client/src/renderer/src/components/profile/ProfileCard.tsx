import { useEffect, useState } from 'react';
import type { User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';
import Avatar from '../servers/Avatar';
import './profile.css';

const DEFAULT_BANNER = 'var(--accent)';

/** Banner image if there is one, otherwise the banner color, otherwise the accent color. */
function bannerBackground(user: User): string {
  return user.profile.bannerColor ?? user.profile.accentColor ?? DEFAULT_BANNER;
}

function memberSince(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Read-only profile card. Used by ProfileTrigger; positioned by its parent. */
export default function ProfileCard({ user, style }: { user: User; style: React.CSSProperties }) {
  const bannerPath = user.profile.bannerUrl;
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    if (!bannerPath) { setBanner(null); return; }
    let alive = true;
    let objectUrl: string | null = null;
    fetchObjectUrl(bannerPath)
      .then((u) => {
        if (!alive) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setBanner(u);
      })
      .catch(() => { /* keep the color */ });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bannerPath]);

  const accent = user.profile.accentColor ?? 'var(--accent)';
  return (
    <div className="profile-card" style={{ ...style, '--profile-accent': accent } as React.CSSProperties} role="dialog" aria-label={`${user.displayName}'s profile`}>
      <div className="profile-banner" style={{ background: banner ? undefined : bannerBackground(user) }}>
        {banner && <img src={banner} alt="" />}
      </div>
      <div className="profile-body">
        <div className="profile-avatar">
          <Avatar user={user} size={72} />
        </div>
        <div className="profile-name">{user.displayName}</div>
        {user.profile.pronouns && <div className="profile-handle"><span className="profile-pronouns">{user.profile.pronouns}</span></div>}
        {user.profile.bio && <p className="profile-bio">{user.profile.bio}</p>}
        <div className="profile-since">Member since {memberSince(user.profile.createdAt)}</div>
      </div>
    </div>
  );
}
