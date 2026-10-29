// The window's layout as data. The base manifest below reproduces today's app; a skin's manifest (docs/SKINS.md) is
// meant to replace these lists. Ids are stable: skins, tests and the feature list refer to them, so rename with care.

/** Settings tabs in display order. Each id has a panel in components/settings/SettingsModal.tsx. */
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
