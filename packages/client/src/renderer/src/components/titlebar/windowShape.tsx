import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSettings } from '../../state/settings';

// The see-through ("shaped") window: the LCARS layout always uses it, and with Seamless layout switching on every layout
// does (lcars/shapedWindow.ts). It has no system border, so the page draws its own resize edges.

/** Whether the window is maximized, kept up to date as it is resized. */
export function useMaximized(): boolean {
  const controls = window.chatward?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls) return;
    const check = () => { void controls.isMaximized().then(setMaximized, () => {}); };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [controls]);
  return maximized;
}

/** True while the page is in the shaped window. It changes when the layout moves the page to the other kind of window. */
export function useShapedWindow(): boolean {
  const controls = window.chatward?.windowControls;
  return useSyncExternalStore(
    (cb) => controls?.onShapedChange?.(cb) ?? (() => {}),
    () => controls?.isShaped?.() === true,
  );
}

const EDGES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const;

/**
 * Thin grab strips along the outside edges that resize the shaped window, which has no system border to drag.
 * `className` places them: 'lcars-resize' on the LCARS frame's curves, 'cw-resize' on a plain rectangle.
 */
export function ResizeEdges({ className }: { className: string }) {
  const controls = window.chatward?.windowControls;
  if (!controls?.startResize) return null;
  const end = () => controls.endResize();
  return (
    <>
      {EDGES.map((edge) => (
        <span key={edge} className={`${className} ${className}-${edge}`} aria-hidden="true"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            controls.startResize(edge);
          }}
          onPointerUp={end} onLostPointerCapture={end} />
      ))}
    </>
  );
}

/**
 * Tabs, Classic and Orbit in the see-through window (Seamless layout switching on): the page is a plain rectangle, so
 * resize strips go along its straight edges. LCARS draws its own along its frame.
 */
export function PlainWindowEdges() {
  const layout = useSettings((s) => s.layout);
  const shaped = useShapedWindow();
  const maximized = useMaximized();
  if (!shaped || maximized || layout === 'lcars') return null;
  return <ResizeEdges className="cw-resize" />;
}
