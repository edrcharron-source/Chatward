import { useRef, useState } from 'react';
import type { User } from '@chatward/shared';
import { useCachedImage } from '../../api/imageCache';
import Avatar from '../servers/Avatar';
import ImageLightbox from '../media/ImageLightbox';
import ListeningNow from '../spotify/ListeningNow';
import './profile.css';

const DEFAULT_BANNER = 'var(--accent)';
// Shown while an uploaded banner is still loading, so the default colour never flashes first.
const LOADING_BANNER = 'var(--bg-3)';

/** Banner image if there is one, otherwise the banner color, otherwise the accent color. */
function bannerBackground(user: User): string {
  if (user.profile.bannerUrl) return LOADING_BANNER;
  return user.profile.bannerColor ?? user.profile.accentColor ?? DEFAULT_BANNER;
}

function memberSince(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Read-only profile card. Used by ProfileTrigger; positioned by its parent. */
export default function ProfileCard({ user, style }: { user: User; style: React.CSSProperties }) {
  const banner = useCachedImage(user.profile.bannerUrl);
  const avatar = useCachedImage(user.avatarUrl);
  const cardRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<{ url: string; name: string } | null>(null);

  const accent = user.profile.accentColor ?? 'var(--accent)';
  // The card sits above everything else; hide it while the viewer is open so the picture is not covered, and bring it back after.
  return (
    <div ref={cardRef} className="profile-card" style={{ ...style, '--profile-accent': accent, visibility: viewing ? 'hidden' : undefined } as React.CSSProperties} role="dialog" aria-label={`${user.displayName}'s profile`}>
      <div className="profile-banner" style={{ background: banner ? undefined : bannerBackground(user) }}>
        {banner && (
          <button type="button" className="profile-image-open" onClick={() => setViewing({ url: banner, name: `${user.displayName}'s banner` })} aria-label={`View ${user.displayName}'s banner`}>
            <img src={banner} alt="" />
          </button>
        )}
      </div>
      <div className="profile-body">
        <div className="profile-avatar">
          {avatar ? (
            <button type="button" className="profile-image-open profile-avatar-open" onClick={() => setViewing({ url: avatar, name: `${user.displayName}'s profile picture` })} aria-label={`View ${user.displayName}'s profile picture`}>
              <Avatar user={user} size={72} />
            </button>
          ) : <Avatar user={user} size={72} />}
        </div>
        <div className="profile-name">{user.displayName}</div>
        {user.profile.pronouns && <div className="profile-handle"><span className="profile-pronouns">{user.profile.pronouns}</span></div>}
        {user.profile.bio && <p className="profile-bio">{user.profile.bio}</p>}
        <ListeningNow userId={user.id} />
        <div className="profile-since">Member since {memberSince(user.profile.createdAt)}</div>
      </div>
      {viewing && (
        <ImageLightbox url={viewing.url} name={viewing.name} onClose={() => setViewing(null)} container={cardRef.current?.ownerDocument.body} />
      )}
    </div>
  );
}
