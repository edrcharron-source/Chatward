import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '@chatward/shared';
import { useSession } from '../../state/session';
import MessageMenu from '../chat/MessageMenu';
import ProfileCard from './ProfileCard';

const CARD_WIDTH = 300;
const GAP = 8;

/**
 * Wraps a name or avatar. Clicking it opens the user's profile card beside it. Right-clicking your own offers
 * "Change display name", which opens your card with the name editable.
 */
export default function ProfileTrigger({ user, className, children }: {
  user: User;
  className?: string;
  children: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ doc: Document; x: number; y: number } | null>(null);
  const me = useSession((s) => s.user);
  const mine = me?.id === user.id;
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

  useEffect(() => { if (!open) setEditing(false); }, [open]);

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
        onClick={() => setOpen((o) => !o)}
        onContextMenu={mine ? (e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ doc: e.currentTarget.ownerDocument, x: e.clientX, y: e.clientY });
        } : undefined}
      >
        {children}
      </button>
      {open && createPortal(
        <div ref={card}><ProfileCard user={mine && me ? me : user} style={pos} editName={mine && editing} /></div>,
        document.body,
      )}
      {menu && (
        <MessageMenu
          doc={menu.doc}
          x={menu.x}
          y={menu.y}
          label="Your options"
          items={[{ label: 'Change display name', onPick: () => { setEditing(true); setOpen(true); } }]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
