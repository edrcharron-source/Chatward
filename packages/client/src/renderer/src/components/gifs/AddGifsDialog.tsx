import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LIMITS } from '@chatward/shared';
import { addLibraryGif, parseTags } from '../../state/gifLibrary';
import { detailsProblem } from './GifDetailsDialog';

const MB = 1024 * 1024;

interface Item {
  file: File;
  url: string;
  name: string;
  /** Why this file can't be added, decided before upload. */
  problem: string | null;
  status: 'waiting' | 'uploading' | 'done' | 'failed';
  error?: string;
}

const isGif = (f: File) => f.type === 'image/gif' || /\.gif$/i.test(f.name);

/** Name for a GIF from its file name: no extension, dashes and underscores as spaces. */
export const nameFromFile = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.LIBRARY_GIF_NAME_MAX);

/** Names and uploads one or more GIF files, from the file picker or dropped on the tab. */
export default function AddGifsDialog({ serverId, files, onClose }: { serverId: string; files: File[]; onClose: () => void }) {
  const initial = useMemo<Item[]>(() => files.map((file) => ({
    file,
    url: URL.createObjectURL(file),
    name: nameFromFile(file.name) || 'GIF',
    problem: !isGif(file) ? "Not a GIF, so it'll be skipped." : file.size > LIMITS.LIBRARY_GIF_MAX_BYTES ? `Over ${LIMITS.LIBRARY_GIF_MAX_BYTES / MB} MB, so it'll be skipped.` : null,
    status: 'waiting',
  })), [files]);
  const [items, setItems] = useState(initial);
  const [tagText, setTagText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => initial.forEach((i) => URL.revokeObjectURL(i.url)), [initial]);

  const usable = items.filter((i) => !i.problem && i.status !== 'done');
  const allDone = items.every((i) => i.problem || i.status === 'done');
  const setItem = (idx: number, change: Partial<Item>) => setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...change } : it)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    for (const it of usable) {
      const problem = detailsProblem(it.name, tagText);
      if (problem) { setError(`${it.file.name}: ${problem}`); return; }
    }
    setBusy(true);
    setError(null);
    const tags = parseTags(tagText);
    let failed = 0;
    // One at a time, so a full quota stops cleanly instead of failing several uploads at once.
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (it.problem || it.status === 'done') continue;
      setItem(idx, { status: 'uploading', error: undefined });
      try {
        await addLibraryGif(serverId, await it.file.arrayBuffer(), it.name.trim(), tags);
        setItem(idx, { status: 'done' });
      } catch (err) {
        failed++;
        setItem(idx, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed.' });
      }
    }
    setBusy(false);
    if (failed === 0) onClose();
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}
    >
      <form className="modal gif-dialog gif-dialog-wide" role="dialog" aria-modal="true" aria-label="Add GIFs" onSubmit={submit}>
        <h3 className="gif-dialog-title">{items.length === 1 ? 'Add a GIF' : `Add ${items.length} GIFs`}</h3>
        <ul className="gif-add-list">
          {items.map((it, idx) => (
            <li key={idx} className="gif-add-row">
              <img src={it.url} alt="" className="gif-add-thumb" />
              <div className="gif-add-fields">
                {it.problem ? (
                  <span className="muted">{it.file.name}: {it.problem}</span>
                ) : (
                  <input
                    aria-label={`Name for ${it.file.name}`}
                    value={it.name}
                    maxLength={LIMITS.LIBRARY_GIF_NAME_MAX}
                    disabled={busy || it.status === 'done'}
                    onChange={(e) => setItem(idx, { name: e.target.value })}
                  />
                )}
                {it.status === 'uploading' && <span className="muted">Uploading…</span>}
                {it.status === 'done' && <span className="muted">Added ✓</span>}
                {it.status === 'failed' && <span className="media-error">{it.error}</span>}
              </div>
            </li>
          ))}
        </ul>
        <label className="gif-field">
          <span className="muted">Tags for {items.length === 1 ? 'it' : 'all of them'} (optional, separated by commas)</span>
          <input value={tagText} disabled={busy} placeholder="reaction, funny" onChange={(e) => setTagText(e.target.value)} />
        </label>
        {error && <div role="alert" className="media-error">{error}</div>}
        <div className="gif-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{allDone ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="primary" disabled={busy || usable.length === 0}>
            {busy ? 'Uploading…' : usable.length === 1 ? 'Add GIF' : `Add ${usable.length} GIFs`}
          </button>
        </div>
      </form>
    </div>
  );
}
