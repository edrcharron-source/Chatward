import { useMemo, type CSSProperties } from 'react';
import { skinLayout } from '../skins';
import { useSettings } from '../state/settings';
import { resolveLayout, type LayoutManifest } from './manifest';

// The feature-parity check sets this before the app loads, so its layout runs through the real render path.
const checkLayout = (globalThis as { __chatwardLayout?: Partial<LayoutManifest> }).__chatwardLayout;

/** The layout of the active skin, or today's layout with no skin. Follows the skin setting live. */
export function useLayout(): LayoutManifest {
  const skin = useSettings((s) => s.skin);
  return useMemo(() => resolveLayout(checkLayout ?? skinLayout(skin)), [skin]);
}

/** Inline grid for `.cw-shell`, so a skin's manifest, not a stylesheet, places the regions. */
export function gridStyle({ grid }: LayoutManifest): CSSProperties {
  return {
    gridTemplateColumns: grid.columns,
    gridTemplateRows: grid.rows,
    gridTemplateAreas: grid.areas.map((row) => `'${row.join(' ')}'`).join(' '),
  };
}
