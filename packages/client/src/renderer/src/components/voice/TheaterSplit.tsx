import { useState, type PointerEvent, type ReactNode } from 'react';

const MIN_TOP_PCT = 25;
const MAX_TOP_PCT = 85;

/** Stacks `top` over `bottom` with a divider the user can drag to give either side more height. */
export default function TheaterSplit({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const [topPct, setTopPct] = useState(60);

  const onDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    const pct = ((e.clientY - box.top) / box.height) * 100;
    setTopPct(Math.min(MAX_TOP_PCT, Math.max(MIN_TOP_PCT, pct)));
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: `0 0 ${topPct}%`, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{top}</div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize theater and chat"
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={onDrag}
        style={{ flex: '0 0 8px', cursor: 'row-resize', background: 'var(--border)' }}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{bottom}</div>
    </div>
  );
}
