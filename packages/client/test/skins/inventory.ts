// The client's user-facing features, by stable id. A skin must reach each one, enabled and clickable, and must not add or
// remove a control (test/skins/parity.ts). `find` locates the control in demo mode by its role and accessible name for
// now. When the menu-data refactor (#253) lands, the ids move onto data-action attributes and `find` follows them.
import type { Locator, Page } from 'playwright-core';

export interface Feature {
  id: string;
  what: string;
  find: (page: Page) => Locator;
}

const channels = (page: Page) => page.getByRole('complementary', { name: 'Channels' });
const members = (page: Page) => page.getByRole('complementary', { name: 'Members' });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

// The settings tabs, in the order the walk visits them.
export const SETTINGS_TABS: Array<[id: string, name: string]> = [
  ['account', 'Account'],
  ['appearance', 'Appearance'],
  ['voice', 'Voice & Video'],
  ['notifications', 'Notifications'],
  ['privacy', 'Privacy'],
  ['security', 'Security'],
];

const settingsTabs: Feature[] = SETTINGS_TABS.map(([id, name]) => ({
  id: `settings.tab-${id}`,
  what: `settings tab: ${name}`,
  find: (page: Page) => settings(page).getByRole('tab', { name, exact: true }),
}));

export const FEATURES: Feature[] = [
  { id: 'auth.try-demo', what: 'start the offline demo', find: (p) => p.getByText('Try demo', { exact: false }) },

  { id: 'channel.open-memes', what: 'open another text channel', find: (p) => channels(p).getByText('memes', { exact: true }) },
  { id: 'channel.create', what: 'create a channel (admin)', find: (p) => p.getByRole('button', { name: 'Create channel', exact: true }) },
  { id: 'server.settings', what: 'open server settings', find: (p) => p.getByRole('button', { name: 'Server settings', exact: true }) },
  { id: 'settings.open', what: 'open app settings', find: (p) => p.getByRole('button', { name: 'Settings', exact: true }) },
  { id: 'settings.close', what: 'close app settings', find: (p) => p.getByRole('button', { name: 'Close settings', exact: true }) },
  { id: 'watch-party.toggle', what: 'watch YouTube together', find: (p) => p.getByTitle('Watch YouTube together', { exact: true }) },

  { id: 'chat.message', what: 'message composer', find: (p) => p.getByLabel('Message', { exact: true }) },
  { id: 'chat.send', what: 'send a message (once text is typed)', find: (p) => p.getByRole('button', { name: 'Send', exact: true }) },
  { id: 'chat.attach', what: 'attach files', find: (p) => p.getByRole('button', { name: 'Attach files', exact: true }) },
  { id: 'chat.emoji', what: 'open the emoji picker', find: (p) => p.getByRole('button', { name: 'Emoji', exact: true }) },
  { id: 'chat.gif', what: 'open the GIF picker', find: (p) => p.getByRole('button', { name: 'GIFs', exact: true }) },
  { id: 'member.profile', what: 'open a member profile', find: (p) => members(p).getByText('Avery', { exact: true }) },

  { id: 'emoji-picker.dialog', what: 'emoji picker opens', find: (p) => p.getByRole('dialog', { name: 'Emoji picker' }) },
  { id: 'gif-picker.dialog', what: 'GIF picker opens', find: (p) => p.getByRole('dialog', { name: 'GIF picker' }) },
  { id: 'gif-picker.search', what: 'GIF search box', find: (p) => p.getByLabel('Search GIFs', { exact: true }) },
  { id: 'server-settings.dialog', what: 'server settings opens', find: (p) => p.getByRole('dialog') },
  { id: 'settings.dialog', what: 'app settings opens', find: (p) => settings(p) },
  ...settingsTabs,
];

const byIdMap = new Map(FEATURES.map((f) => [f.id, f]));

export function byId(id: string): Feature {
  const feature = byIdMap.get(id);
  if (!feature) throw new Error(`unknown feature id: ${id}`);
  return feature;
}
