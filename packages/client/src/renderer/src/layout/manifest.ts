// The window's layout as data. BASE_LAYOUT reproduces today's app; a skin may replace any part of it with its own
// layout.ts (docs/SKINS.md). Ids are stable: skins, tests and the feature list refer to them, so rename with care.
// A skin may move, reorder and regroup. It may not add or remove an id, so every feature stays reachable.

/** Settings tabs by id, with their labels. Each id has a panel in components/settings/SettingsModal.tsx. */
export const SETTINGS_TABS = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Video' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'security', label: 'Security' },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/** Actions in the bar above the main area, left to right. Each id is rendered in App.tsx. */
export const MAIN_BAR = ['sidebars', 'test', 'watch'] as const;

export type MainBarId = (typeof MAIN_BAR)[number];

/** The main window's panels. Each is a `data-region` element; the components never change where a region sits. */
export const REGIONS = ['servers', 'channels', 'main', 'members'] as const;

export type RegionId = (typeof REGIONS)[number];

/** A group of settings tabs. A label, when given, is shown above the group. */
export interface SettingsGroup {
  id: string;
  label?: string;
  tabs: SettingsTabId[];
}

export interface LayoutManifest {
  /** The main window's grid on `.cw-shell`. Each row lists region ids, left to right; every region appears once. */
  grid: {
    columns: string;
    rows: string;
    areas: RegionId[][];
  };
  /** Main-bar actions, in order. */
  mainBar: MainBarId[];
  /** Settings tabs in display order, split into groups. Flattened, they list every tab once. */
  settingsGroups: SettingsGroup[];
}

/** Today's layout: server rail, channel list, main area, member list in one row; the settings tabs in one group. */
export const BASE_LAYOUT: LayoutManifest = {
  grid: {
    columns: 'auto auto minmax(0, 1fr) auto',
    rows: 'minmax(0, 1fr)',
    areas: [['servers', 'channels', 'main', 'members']],
  },
  mainBar: [...MAIN_BAR],
  settingsGroups: [{ id: 'all', tabs: SETTINGS_TABS.map((t) => t.id) }],
};

/** Problems that make a layout unusable. An empty list means the layout is valid. */
export function layoutErrors(layout: LayoutManifest): string[] {
  const errors: string[] = [];
  const { columns, rows, areas } = layout.grid;
  if (!columns.trim() || !rows.trim()) errors.push('grid columns and rows must not be empty');
  if (areas.length === 0 || areas.some((row) => row.length !== areas[0].length || row.length === 0)) {
    errors.push('grid areas must be rows of equal, non-zero length');
  }
  errors.push(...exactlyOnce('grid area', areas.flat(), REGIONS));
  errors.push(...exactlyOnce('main-bar action', layout.mainBar, MAIN_BAR));
  if (layout.settingsGroups.some((g) => g.tabs.length === 0)) errors.push('a settings group must have a tab');
  errors.push(...exactlyOnce('settings tab', layout.settingsGroups.flatMap((g) => g.tabs), SETTINGS_TABS.map((t) => t.id)));
  return errors;
}

/**
 * The base layout with a skin's overrides applied. A skin that fails validation gets the base layout and a console
 * warning, so a bad manifest changes the look at most and never drops a feature.
 */
export function resolveLayout(overrides?: Partial<LayoutManifest>): LayoutManifest {
  if (!overrides) return BASE_LAYOUT;
  const layout: LayoutManifest = { ...BASE_LAYOUT, ...overrides };
  const errors = layoutErrors(layout);
  if (errors.length === 0) return layout;
  console.warn('[layout] skin manifest ignored:', errors.join('; '));
  return BASE_LAYOUT;
}

/** Each expected id appears exactly once in `got`, and nothing else does. */
function exactlyOnce(what: string, got: readonly string[], want: readonly string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const id of got) {
    if (!want.includes(id)) errors.push(`unknown ${what} "${id}"`);
    else if (seen.has(id)) errors.push(`${what} "${id}" appears twice`);
    seen.add(id);
  }
  for (const id of want) if (!seen.has(id)) errors.push(`${what} "${id}" is missing`);
  return errors;
}
