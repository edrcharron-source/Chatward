import { useEffect, useRef, type ReactElement } from 'react';
import 'emoji-picker-element'; // registers the <emoji-picker> custom element; without it the panel renders empty
import { usePopover } from './Popover';

type EmojiPickerElement = HTMLElement & { dataSource: string };

// Emoji data ships inside the app bundle. It is served from a blob URL so the picker never
// falls back to its default CDN, and the JSON is code-split so it only loads on first use.
let emojiDataUrl: Promise<string> | null = null;
function getEmojiDataUrl(): Promise<string> {
  emojiDataUrl ??= import('emoji-picker-element-data/en/emojibase/data.json').then(({ default: data }) =>
    URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })),
  );
  return emojiDataUrl;
}

function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let alive = true;
    let picker: EmojiPickerElement | null = null;
    const onEmojiClick = (e: Event) => {
      const unicode = (e as CustomEvent<{ unicode?: string }>).detail?.unicode;
      if (unicode) pickRef.current(unicode);
    };
    void getEmojiDataUrl().then((url) => {
      if (!alive || !host.current) return;
      // Set the data source before the element connects, or it starts fetching the default CDN data.
      picker = document.createElement('emoji-picker') as EmojiPickerElement;
      picker.dataSource = url;
      picker.addEventListener('emoji-click', onEmojiClick);
      host.current.appendChild(picker);
    });
    return () => {
      alive = false;
      picker?.removeEventListener('emoji-click', onEmojiClick);
      picker?.remove();
    };
  }, []);

  return <div ref={host} className="media-emoji-picker" />;
}

export function EmojiPickerButton({ onPick }: { onPick: (emoji: string) => void }): ReactElement {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="media-anchor" ref={ref}>
      <button
        type="button"
        className="icon media-toolbar-btn"
        aria-label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </button>
      {open && (
        <div className="media-popover media-emoji-popover" role="dialog" aria-label="Emoji picker">
          <EmojiPanel
            onPick={(emoji) => {
              onPick(emoji);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
