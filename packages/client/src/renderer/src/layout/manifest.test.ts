// Run with: npm run test:layout -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_LAYOUT, layoutErrors, resolveLayout, type LayoutManifest } from './manifest';

test('the base layout is today\'s window and settings', () => {
  assert.deepEqual(BASE_LAYOUT.grid.areas, [['servers', 'channels', 'main', 'members']]);
  assert.equal(BASE_LAYOUT.grid.columns, 'auto auto minmax(0, 1fr) auto');
  assert.deepEqual(BASE_LAYOUT.mainBar, ['sidebars', 'test', 'watch']);
  assert.deepEqual(BASE_LAYOUT.settingsGroups, [
    { id: 'all', tabs: ['account', 'appearance', 'voice', 'notifications', 'privacy', 'security'] },
  ]);
  assert.deepEqual(layoutErrors(BASE_LAYOUT), []);
});

test('no skin resolves to the base layout', () => {
  assert.equal(resolveLayout(undefined), BASE_LAYOUT);
});

test('a skin can move panels, reorder the bar and regroup settings without dropping anything', () => {
  const layout = resolveLayout({
    grid: {
      columns: 'minmax(0, 1fr) auto',
      rows: 'minmax(0, 1fr) auto',
      areas: [['main', 'members'], ['servers', 'channels']],
    },
    mainBar: ['watch', 'test', 'sidebars'],
    settingsGroups: [
      { id: 'you', label: 'You', tabs: ['account', 'privacy', 'security'] },
      { id: 'app', label: 'App', tabs: ['appearance', 'voice', 'notifications'] },
    ],
  });
  assert.equal(layout.grid.areas.length, 2);
  assert.deepEqual(layout.mainBar, ['watch', 'test', 'sidebars']);
  assert.equal(layout.settingsGroups[0].label, 'You');
  assert.deepEqual(layoutErrors(layout), []);
});

test('a skin that keeps only some regions is refused and gets the base layout', () => {
  const broken: Partial<LayoutManifest> = { grid: { columns: 'auto', rows: 'auto', areas: [['main']] } };
  assert.match(layoutErrors({ ...BASE_LAYOUT, ...broken }).join('\n'), /"servers" is missing/);
  assert.equal(resolveLayout(broken), BASE_LAYOUT);
});

test('a skin that drops a settings tab is refused', () => {
  const broken: Partial<LayoutManifest> = {
    settingsGroups: [{ id: 'all', tabs: ['account', 'appearance', 'voice', 'notifications', 'privacy'] }],
  };
  assert.match(layoutErrors({ ...BASE_LAYOUT, ...broken }).join('\n'), /settings tab "security" is missing/);
  assert.equal(resolveLayout(broken), BASE_LAYOUT);
});

test('a skin that repeats or invents an action is refused', () => {
  const repeated = layoutErrors({ ...BASE_LAYOUT, mainBar: ['sidebars', 'sidebars', 'watch'] as LayoutManifest['mainBar'] });
  assert.match(repeated.join('\n'), /main-bar action "sidebars" appears twice/);
  assert.match(repeated.join('\n'), /main-bar action "test" is missing/);
  const invented = layoutErrors({ ...BASE_LAYOUT, mainBar: ['sidebars', 'test', 'watch', 'share'] as LayoutManifest['mainBar'] });
  assert.match(invented.join('\n'), /unknown main-bar action "share"/);
});

test('a grid whose rows differ in length is refused', () => {
  const ragged = layoutErrors({
    ...BASE_LAYOUT,
    grid: { ...BASE_LAYOUT.grid, areas: [['servers', 'channels', 'main', 'members'], ['main']] },
  });
  assert.match(ragged.join('\n'), /equal, non-zero length/);
});
