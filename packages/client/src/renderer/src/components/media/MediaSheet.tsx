import { useEffect, useRef, type ReactElement } from 'react';
import type { Gif } from '../../state/chat';
import GifLibraryPanel from '../gifs/GifLibraryPanel';
import { EmojiPanel } from './EmojiPicker';
import { GifPanel } from './GifPicker';

export type SheetTab = 'emoji' | 'server' | 'klipy';

const TABS: { id: SheetTab; label: string }[] = [
  { id: 'emoji', label: 'Emoji' },
  { id: 'server', label: 'GIFs' },
  { id: 'klipy', label: 'Klipy' },
];

interface Props {
  tab: SheetTab;
  onTab: (tab: SheetTab) => void;
  serverId: string;
  onEmoji: (emoji: string) => void;
  onGif: (gif: Gif) => void;
  onClose: () => void;
}

/**
 * The phone's emoji and GIF picker: a full-width panel along the bottom of the screen, under the message box, where the
 * keyboard would be. Tabs switch between emoji, the server's GIFs and Klipy. Emoji stay open so several can be added;
 * picking a GIF closes it. Escape or the handle at the top closes it.
 */
export function MediaSheet({ tab, onTab, serverId, onEmoji, onGif, onClose }: Props): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('keydown', onKeyDown);
    return () => doc.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div ref={ref} className="media-sheet" role="dialog" aria-label="Emoji and GIFs">
      <button type="button" className="media-sheet-handle" aria-label="Close emoji and GIFs" onClick={onClose}>
        <span aria-hidden="true" />
      </button>
      <div className="media-sheet-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="media-sheet-body">
        {tab === 'emoji' && <EmojiPanel onPick={onEmoji} />}
        {tab === 'server' && <GifLibraryPanel serverId={serverId} onPick={onGif} />}
        {tab === 'klipy' && <GifPanel onPick={onGif} />}
      </div>
    </div>
  );
}
