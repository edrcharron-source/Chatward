import { useState } from 'react';
import './scroll.css';
import { pickEmoji } from './emoji';

/** The big "Scroll!" button in the top bar. Its emoji is picked once per mount, at random. */
export default function ScrollButton({ onOpen }: { onOpen: () => void }) {
  const [emoji] = useState(() => pickEmoji());
  return (
    <button type="button" className="cw-tool cw-scroll-btn" onClick={onOpen} aria-haspopup="dialog">
      <span className="cw-scroll-btn-text">Scroll!</span>
      <span className="cw-scroll-btn-emoji" aria-hidden="true">{emoji}</span>
    </button>
  );
}
