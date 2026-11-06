import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '@chatward/shared';
import ProfileCard from './ProfileCard';
import { preloadImages } from '../../api/imageCache';

const CARD_WIDTH = 300;
const GAP = 8;

/** Wraps a name or avatar. Clicking it opens the user's profile card beside it. */
export default function ProfileTrigger({ user, className, children }: {
  user: User;
  className?: string;
  children: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});

  // Place the card under the trigger, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const view = btn.current.ownerDocument.defaultView ?? window;
    const left = Math.min(Math.max(GAP, r.left), view.innerWidth - CARD_WIDTH - GAP);
    const top = r.bottom + GAP + 340 > view.innerHeight ? Math.max(GAP, r.top - 340 - GAP) : r.bottom + GAP;
    setPos({ position: 'fixed', left, top, width: CARD_WIDTH, zIndex: 1000 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // Clicks in the picture viewer opened from the card must not close the card (and the viewer with it).
      if ((t as Element).closest?.('.media-lightbox')) return;
      if (!card.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const doc = btn.current?.ownerDocument ?? document;
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`profile-trigger ${className ?? ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Start loading the card's pictures as soon as the pointer is over the profile, so they are ready when it opens.
        onPointerEnter={() => preloadImages(user.avatarUrl, user.profile.bannerUrl)}
        onFocus={() => preloadImages(user.avatarUrl, user.profile.bannerUrl)}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && createPortal(
        <div ref={card}><ProfileCard user={user} style={pos} /></div>,
        document.body,
      )}
    </>
  );
}
