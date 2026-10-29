import { useMemo, type CSSProperties } from 'react';
import { skinLayout } from '../skins';
import { useSettings } from '../state/settings';
import { resolveLayout, type LayoutManifest } from './manifest';

/** The layout of the active skin, or today's layout with no skin. Follows the skin setting live. */
export function useLayout(): LayoutManifest {
  const skin = useSettings((s) => s.skin);
  return useMemo(() => resolveLayout(skinLayout(skin)), [skin]);
}

/** Inline grid for `.cw-shell`, so a skin's manifest, not a stylesheet, places the regions. */
export function gridStyle({ grid }: LayoutManifest): CSSProperties {
  return {
    gridTemplateColumns: grid.columns,
    gridTemplateRows: grid.rows,
    gridTemplateAreas: grid.areas.map((row) => `'${row.join(' ')}'`).join(' '),
  };
}
