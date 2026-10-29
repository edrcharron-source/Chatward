import { useRef, useState, type CSSProperties } from 'react';
import PixelIcon from '../icons/PixelIcon';
import { usePopover } from '../media/Popover';
import SoundboardPanel from './SoundboardPanel';

const WIDTH = 360;
const GAP = 8;

/** The call controls' Soundboard button. The sounds open in a pop-up above it and close on a click outside or Escape. */
export default function SoundboardButton({ serverId, channelId }: { serverId: string; channelId: string }) {
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
      <button ref={button} aria-label="Soundboard" title="Soundboard" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <PixelIcon name="sounds" size={18} />
      </button>
      {open && (
        <div
          className="media-popover"
          role="dialog"
          aria-label="Soundboard"
          style={{ position: 'fixed', top: 'auto', right: 'auto', padding: 0, overflowY: 'auto', ...place }}
        >
          <SoundboardPanel serverId={serverId} channelId={channelId} />
        </div>
      )}
    </div>
  );
}
