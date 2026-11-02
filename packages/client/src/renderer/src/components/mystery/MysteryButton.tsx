import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MYSTERY_RULES, MYSTERY_TITLE } from './rules';
import './mystery.css';

// An inside joke: the group's homemade murder mystery. Opening it reads the (deliberately endless) rules aloud with
// the system's own voice and shows them in 1px text. Nothing leaves the computer; closing it stops the reading.

/** Reads the rules one sentence at a time, since Chromium tends to stop long utterances part way through. */
function readAloud(): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  for (const sentence of MYSTERY_RULES.join(' ').match(/[^.!?]+[.!?]*/g) ?? []) {
    const u = new SpeechSynthesisUtterance(sentence.trim());
    u.rate = 0.9;
    synth.speak(u);
  }
}

function stopReading(): void {
  window.speechSynthesis?.cancel();
}

function MysteryScreen({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    readAloud();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); stopReading(); };
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal cw-mystery" role="dialog" aria-label={MYSTERY_TITLE}>
        <h2>🔪 {MYSTERY_TITLE}</h2>
        <p className="muted">The rules are being read aloud. They are also printed below, for your convenience.</p>
        <div className="cw-mystery-rules">
          {MYSTERY_RULES.map((para, i) => <p key={i}>{para}</p>)}
        </div>
        <div className="cw-mystery-actions">
          <button type="button" onClick={readAloud}>Start over</button>
          <button type="button" onClick={stopReading}>Stop reading</button>
          <button type="button" className="primary" onClick={onClose}>Close (confess)</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The button that opens the murder mystery. `className` and `children` let each layout dress it its own way. */
export default function MysteryButton({ className = 'icon', children }: { className?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} title={MYSTERY_TITLE} aria-label={MYSTERY_TITLE} onClick={() => setOpen(true)}>
        {children ?? '🔪'}
      </button>
      {open && <MysteryScreen onClose={() => setOpen(false)} />}
    </>
  );
}
