// The watch party's "Up next" list: a thumbnail per item, a grip to drag items into a new order, and Remove.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { fetchObjectUrl } from '../../api/http';
import type { QueueItem } from './sync';

/** How far the pointer has to travel before a press on the grip becomes a drag. */
const DRAG_START_PX = 4;

/** YouTube serves a 320x180 still for every video id; `ref` is already checked against the id pattern. */
const youtubeThumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/** A small preview: the YouTube still, the movie's poster from Jellyfin, or a plain tile when there is no picture. */
function Thumb({ item, label }: { item: QueueItem; label: string }): ReactElement {
  const [src, setSrc] = useState<string | null>(item.kind === 'youtube' ? youtubeThumb(item.ref) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (item.kind === 'youtube') { setSrc(youtubeThumb(item.ref)); return; }
    setSrc(null);
    if (item.kind !== 'jellyfin') return;
    // The poster comes through our own server, signed in, like the Movies browser does it.
    let url: string | null = null;
    let live = true;
    fetchObjectUrl(`/api/jellyfin/items/${item.ref}/poster`)
      .then((u) => { if (live) { url = u; setSrc(u); } else URL.revokeObjectURL(u); })
      .catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [item.kind, item.ref]);
  const cls = `watch-party-thumb${item.kind === 'jellyfin' ? ' poster' : ''}`;
  if (src && !failed) return <img className={cls} src={src} alt="" draggable={false} onError={() => setFailed(true)} />;
  return <span className={`${cls} empty`} aria-hidden="true">{item.kind === 'jellyfin' ? label.slice(0, 1).toUpperCase() : '▶'}</span>;
}

interface Drag {
  from: number;
  ref: string;
  pointerId: number;
  startY: number;
  /** pointer travel since the press, so the dragged row follows the pointer */
  dy: number;
  /** the gap (0..length) the item would drop into, or null before the drag has started */
  gap: number | null;
}

/** The gap a pointer at `y` points at: just after the last row (other than the one being dragged) whose middle is above it. */
function gapAt(list: HTMLOListElement, y: number, skip: number): number {
  let gap = 0;
  Array.from(list.children).forEach((row, i) => {
    if (i === skip) return; // it follows the pointer, so its own box says nothing
    const r = row.getBoundingClientRect();
    if (y > r.top + r.height / 2) gap = i + 1;
  });
  return gap;
}

/** Where the item lands for a drop into `gap` (gaps after the item shift by one once it is lifted out). */
const indexForGap = (from: number, gap: number) => (gap > from ? gap - 1 : gap);

export function QueueList({ queue, label, onMove, onRemove }: {
  queue: QueueItem[];
  label: (it: QueueItem) => string;
  onMove: (from: number, to: number, ref: string) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const set = (d: Drag | null) => { dragRef.current = d; setDrag(d); };

  const down = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    set({ from: i, ref: queue[i].ref, pointerId: e.pointerId, startY: e.clientY, dy: 0, gap: null });
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    const list = listRef.current;
    if (!d || !list || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    if (d.gap === null && Math.abs(dy) < DRAG_START_PX) return;
    e.preventDefault();
    set({ ...d, dy, gap: gapAt(list, e.clientY, d.from) });
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    set(null);
    if (d.gap !== null) onMove(d.from, indexForGap(d.from, d.gap), d.ref);
  };
  const cancel = () => set(null);

  /** Keyboard: arrow up and down on the grip move the item one place. */
  const key = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
    if (to === null || to < 0 || to >= queue.length) return;
    e.preventDefault();
    onMove(i, to, queue[i].ref);
  };

  // Someone else changing the queue mid-drag ends the drag; the drop would be checked against the new queue anyway.
  useEffect(() => {
    const d = dragRef.current;
    if (d && queue[d.from]?.ref !== d.ref) set(null);
  }, [queue]);

  // The marker only shows when the drop would actually change the order.
  const marker = drag && drag.gap !== null && indexForGap(drag.from, drag.gap) !== drag.from ? drag.gap : null;

  return (
    <ol ref={listRef} className={`watch-party-queue${drag?.gap != null ? ' sorting' : ''}`} aria-label="Up next">
      {queue.map((it, i) => {
        const name = label(it);
        const lifted = drag?.gap != null && drag.from === i;
        const cls = [
          lifted ? 'dragging' : '',
          marker === i ? 'drop-before' : '',
          marker === queue.length && i === queue.length - 1 ? 'drop-after' : '',
        ].filter(Boolean).join(' ');
        return (
          <li key={`${i}-${it.ref}`} className={cls || undefined} style={lifted ? { transform: `translateY(${drag!.dy}px)` } : undefined}>
            <button
              type="button"
              className="watch-party-grip"
              aria-label={`Move ${name}. Drag, or use the up and down arrow keys.`}
              title="Drag to reorder"
              onPointerDown={(e) => down(e, i)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onKeyDown={(e) => key(e, i)}
            >⠿</button>
            <span className="watch-party-queue-num">{i + 1}</span>
            <Thumb item={it} label={name} />
            <span className="watch-party-queue-title">{name}</span>
            <button type="button" aria-label={`Remove ${name} from the queue`} onClick={() => onRemove(i)}>Remove</button>
          </li>
        );
      })}
    </ol>
  );
}
