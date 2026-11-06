import { useRef, useState, type FormEvent } from 'react';
import { LIMITS, type User } from '@chatward/shared';
import { api } from '../../api/http';
import { useCachedImage } from '../../api/imageCache';
import { useSession } from '../../state/session';
import { errorText } from '../settings/controls';
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

/**
 * Your display name on your own card, opened from "Change display name". Click the name to type a new one; Enter
 * or clicking away saves, Escape cancels. Only for show: you still sign in with your username.
 */
function NameEditor({ user }: { user: User }) {
  const setUser = useSession((s) => s.setUser);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // Set on Escape, so the blur that follows does not save what was cancelled.
  const cancelled = useRef(false);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (draft === null || busy.current || cancelled.current) return;
    if (draft.trim() === user.displayName) { setDraft(null); return; }
    busy.current = true;
    try {
      const res = await api.patch<{ user: User }>('/api/me', { displayName: draft });
      setUser(res.user);
      setDraft(null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      busy.current = false;
    }
  }

  return (
    <>
      {draft === null ? (
        <button type="button" className="profile-name profile-name-edit" onClick={() => { cancelled.current = false; setDraft(user.displayName); }} title="Click to change your display name">
          {user.displayName}
        </button>
      ) : (
        <form onSubmit={(e) => void save(e)}>
          <input
            className="profile-name profile-name-input"
            value={draft}
            maxLength={LIMITS.DISPLAY_NAME_MAX}
            aria-label="Display name"
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              cancelled.current = true;
              setDraft(null);
              setError(null);
            }}
          />
        </form>
      )}
      <div className="profile-name-hint">
        {error ?? `Click your name to change it. You still sign in as ${user.username}.`}
      </div>
    </>
  );
}

/** A profile card, read-only unless `editName` (your own card, opened to change your display name). Used by ProfileTrigger; positioned by its parent. */
export default function ProfileCard({ user, style, editName = false }: { user: User; style: React.CSSProperties; editName?: boolean }) {
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
        {editName ? <NameEditor user={user} /> : <div className="profile-name">{user.displayName}</div>}
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
