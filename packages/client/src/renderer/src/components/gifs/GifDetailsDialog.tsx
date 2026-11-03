import { useState, type FormEvent, type ReactNode } from 'react';
import { LIMITS } from '@chatward/shared';
import { parseTags } from '../../state/gifLibrary';

/** Plain-words problem with a name or tags, or null when both are fine. Mirrors the server's rules. */
export function detailsProblem(name: string, tagText: string): string | null {
  if (!name.trim()) return 'Give the GIF a name.';
  if (name.trim().length > LIMITS.LIBRARY_GIF_NAME_MAX) return `Names can be up to ${LIMITS.LIBRARY_GIF_NAME_MAX} characters.`;
  const tags = parseTags(tagText);
  if (tags.length > LIMITS.LIBRARY_GIF_TAGS_MAX) return `Up to ${LIMITS.LIBRARY_GIF_TAGS_MAX} tags.`;
  if (tags.some((t) => t.length > LIMITS.LIBRARY_GIF_TAG_MAX)) return `Tags can be up to ${LIMITS.LIBRARY_GIF_TAG_MAX} characters each.`;
  return null;
}

/** Name and tags for one GIF, with a preview. Used to add, save from chat, and rename. */
export default function GifDetailsDialog({ title, preview, initialName = '', initialTags = [], submitLabel, note, onSubmit, onClose }: {
  title: string;
  preview: ReactNode;
  initialName?: string;
  initialTags?: string[];
  submitLabel: string;
  note?: string;
  /** Rejects with a message to show. */
  onSubmit: (name: string, tags: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName.slice(0, LIMITS.LIBRARY_GIF_NAME_MAX));
  const [tagText, setTagText] = useState(initialTags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = detailsProblem(name, tagText);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), parseTags(tagText));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}
    >
      <form className="modal gif-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
        <h3 className="gif-dialog-title">{title}</h3>
        <div className="gif-dialog-preview">{preview}</div>
        <label className="gif-field">
          <span className="muted">Name</span>
          <input value={name} maxLength={LIMITS.LIBRARY_GIF_NAME_MAX} disabled={busy} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="gif-field">
          <span className="muted">Tags (optional, separated by commas)</span>
          <input value={tagText} disabled={busy} placeholder="reaction, funny" onChange={(e) => setTagText(e.target.value)} />
        </label>
        {note && <p className="muted gif-note">{note}</p>}
        {error && <div role="alert" className="media-error">{error}</div>}
        <div className="gif-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
