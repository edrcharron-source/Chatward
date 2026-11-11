import { useRef, useState, type CSSProperties } from 'react';
import PixelIcon from '../icons/PixelIcon';
import { usePopover } from '../media/Popover';
import SoundboardPanel from './SoundboardPanel';
import { LcarsPopFrame } from '../lcars/LcarsPopFrame';

const WIDTH = 360;
const GAP = 8;

/**
 * The call controls' Soundboard button. The sounds open in a pop-up above it and close on a click outside or Escape.
 * `labelled` shows the word instead of the icon (the LCARS bottom bar), and the pop-up then wears the LCARS frame.
 */
export default function SoundboardButton({ serverId, channelId, labelled = false, words = false, className }: {
  serverId: string;
  channelId: string;
  labelled?: boolean;
  /** keep the icon and add the word beside it (the Orbit layout's call card) */
  words?: boolean;
  className?: string;
}) {
  const { open, setOpen, ref } = usePopover();
  const button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});

  const toggle = () => {
    const el = button.current;
    if (!open && el) {
      // fixed to the window, so the pop-up fits wherever the controls sit (bottom bar, sidebar or a popped-out window)
      const r = el.getBoundingClientRect();
      const view = el.ownerDocument.defaultView ?? window;
      const width = Math.min(WIDTH, view.innerWidth - GAP * 2);
      const left = Math.max(GAP, Math.min(r.right - width, view.innerWidth - width - GAP));
      setPlace({ left, width, bottom: view.innerHeight - r.top + GAP, maxHeight: Math.max(160, r.top - GAP * 2) });
    }
    setOpen(!open);
  };

  return (
    <div ref={ref} className="media-anchor">
      <button ref={button} className={className} aria-label="Soundboard" title="Soundboard" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        {labelled ? <span className="lcars-label">Soundboard</span> : <PixelIcon name="sounds" size={18} />}
        {words && <span className="cw-call-word">Soundboard</span>}
      </button>
      {open && (
        <div
          className={`media-popover cw-soundboard-pop${labelled ? ' lcars-pop' : ''}`}
          role="dialog"
          aria-label="Soundboard"
          style={{ position: 'fixed', top: 'auto', right: 'auto', padding: 0, overflowY: 'auto', ...place }}
        >
          {labelled && <LcarsPopFrame />}
          <SoundboardPanel serverId={serverId} channelId={channelId} />
        </div>
      )}
    </div>
  );
}
