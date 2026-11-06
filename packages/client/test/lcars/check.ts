// Checks that the LCARS layout keeps every feature of the Tabs layout (docs/SKINS.md, "LCARS"). It runs the built app in
// demo mode twice, once in the Tabs layout and once in the LCARS layout, walks the same screens in both (chat, the call,
// the soundboard, watch together, vault, split view, server settings, settings), and fails if any control the Tabs
// layout shows is missing in LCARS. It also uses the LCARS frame's own controls: split, pop-out, tab reorder, Join voice,
// Leave, and switching back to the Tabs layout. Screenshots land in the out dir.
// Needs xvfb on Linux. Run with: npm run lcars:check -w @chatward/client -- <out dir> [app dir]
// With --layout=orbit (npm run orbit:check) it checks the Orbit layout the same way instead, plus the Orbit frame's own
// behaviour (title bar replaced by the top bar, window buttons in it, the line drawing, switching layouts).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { DEFAULT_APP_DIR, closePopups, launch, settle } from '../visual/harness';

const CONTROLS = [
  'button', 'a[href]', 'input', 'select', 'textarea', '[role="button"]', '[role="tab"]', '[role="menuitem"]',
  '[role="switch"]', '[role="checkbox"]', '[role="option"]', '[role="textbox"]', '[role="separator"][tabindex]',
].join(', ');

// Controls whose name says the same thing in both layouts but is drawn differently.
const SAME: Record<string, string> = {};

type Screens = Record<string, string[]>;

async function controls(page: Page): Promise<string[]> {
  return page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((el) => el.getClientRects().length > 0)
    // Messages are not controls of the layout, and the demo bots post on their own clock, so the chat history differs.
    .filter((el) => !el.closest('.cv-list'))
    .map((el) => {
      // Orbit's member list adds a live "Speaking" line under whoever is talking; it is a state, not a control.
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.cw-member-speaking').forEach((n) => n.remove());
      return `${el.tagName.toLowerCase()}|${el.getAttribute('aria-label') ?? el.getAttribute('title')
        ?? copy.textContent?.replace(/[[\]]/g, '').trim() ?? el.getAttribute('placeholder') ?? ''}`;
    }), CONTROLS);
}

// The harness pins the tabs layout before every load; this runs after it and picks the layout under test instead.
async function setLayout(page: Page, layout: string, skin: string) {
  await page.context().addInitScript(({ layout, skin }) => {
    const saved = JSON.parse(localStorage.getItem('chatward.settings') ?? '{}');
    localStorage.setItem('chatward.settings', JSON.stringify({ ...saved, layout, skin }));
  }, { layout, skin });
  await page.reload();
  await page.waitForLoadState('load');
}

// The call controls: the tabs layout's corner card, or the LCARS bottom bar.
const dock = (page: Page) => page.getByRole('group', { name: 'Voice chat', exact: true });
const tab = (page: Page, name: string) => page.locator(`[data-tab]`).getByRole('button', { name, exact: false }).first();

async function walk(page: Page, shoot: (name: string) => Promise<void>): Promise<Screens> {
  const screens: Screens = {};
  const snap = async (name: string) => { await settle(page); screens[name] = await controls(page); await shoot(name); };

  await page.getByText('Try demo', { exact: false }).click();
  await page.getByLabel('Message', { exact: true }).waitFor();
  await snap('1-text');

  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  await page.getByRole('dialog', { name: 'Emoji picker' }).waitFor();
  await closePopups(page);
  await page.getByRole('button', { name: 'GIFs', exact: true }).click();
  await page.getByRole('dialog', { name: 'GIF picker' }).waitFor();
  await snap('2-gif-picker');
  await closePopups(page);

  await page.getByRole('complementary', { name: 'Members' }).getByText('Avery', { exact: true }).click();
  await snap('3-profile');
  await closePopups(page);

  await page.getByLabel('Message', { exact: true }).fill('hello from the check');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('hello from the check').first().waitFor();

  await tab(page, 'Voice').click();
  await snap('4-voice-not-in-call');
  await page.locator('[data-region="main"]').getByRole('button', { name: /^join/i }).first().click();
  await dock(page).getByRole('button', { name: 'Leave voice', exact: true }).waitFor();
  await dock(page).getByRole('button', { name: 'Soundboard', exact: true }).waitFor();
  await snap('5-voice-in-call');

  await dock(page).getByRole('button', { name: 'Soundboard', exact: true }).click();
  await page.getByRole('dialog', { name: 'Soundboard' }).waitFor();
  await snap('6-soundboard');
  await closePopups(page);

  await dock(page).getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await dock(page).getByRole('button', { name: 'Unmute microphone', exact: true }).waitFor();
  await snap('7-muted');
  await dock(page).getByRole('button', { name: 'Unmute microphone', exact: true }).click();

  await tab(page, 'Watch together').click();
  await snap('8-watch');
  await tab(page, 'Vault').click();
  await snap('9-vault');

  await tab(page, 'Text').click();
  // Shift+click a tab shows it beside the open one; Shift+click it again closes that side.
  await tab(page, 'Vault').click({ modifiers: ['Shift'] });
  await page.getByRole('separator').first().waitFor();
  await snap('10-split');
  await tab(page, 'Vault').click({ modifiers: ['Shift'] });

  await page.getByRole('button', { name: 'Server settings', exact: true }).click();
  await page.getByRole('dialog').first().waitFor();
  await snap('11-server-settings');
  await closePopups(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Appearance', exact: true }).click();
  await snap('12-settings-appearance');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  return screens;
}

function missingFrom(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const item of b) left.set(SAME[item] ?? item, (left.get(SAME[item] ?? item) ?? 0) + 1);
  const out: string[] = [];
  for (const raw of a) {
    const item = SAME[raw] ?? raw;
    const n = left.get(item) ?? 0;
    if (n > 0) left.set(item, n - 1);
    else out.push(raw);
  }
  return out;
}

async function run(layout: string, skin: string, appDir: string, outDir: string) {
  const dir = path.join(outDir, layout);
  fs.mkdirSync(dir, { recursive: true });
  const { app, page } = await launch('dark', appDir, skin, ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
  try {
    await setLayout(page, layout, skin);
    const shoot = (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' }).then(() => {});
    const screens = await walk(page, shoot);
    const problems: string[] = [];
    if (layout === 'lcars') problems.push(...await lcarsOnly(page, app, shoot));
    if (layout === 'orbit') problems.push(...await orbitOnly(page, app, shoot));
    return { screens, problems };
  } finally {
    await app.close();
  }
}

// The LCARS frame's own behaviour.
async function lcarsOnly(page: Page, app: Awaited<ReturnType<typeof launch>>['app'], shoot: (name: string) => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const check = async (what: string, step: () => Promise<unknown>) => {
    try { await step(); } catch (err) { problems.push(`${what}: ${(err as Error).message.split('\n')[0]}`); }
  };
  await check('the app title bar is hidden behind the frame', async () => {
    if (await page.locator('.cw-titlebar').isVisible()) throw new Error('title bar still showing');
  });
  await check('window buttons sit in the frame', async () => {
    for (const name of ['Minimize', 'Maximize', 'Close']) await page.locator('.lcars-top').getByRole('button', { name, exact: true }).waitFor({ timeout: 2000 });
  });
  await check('Alt+Down moves a tab down the rail', async () => {
    await tab(page, 'Text').focus();
    await page.keyboard.press('Alt+ArrowDown');
    const order = await page.locator('.lcars-rail [data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    if (order[0] !== 'voice' || order[1] !== 'text') throw new Error(`order is ${order.join(',')}`);
    await page.keyboard.press('Alt+ArrowUp');
  });
  await check('a tab pops out into its own window and comes back', async () => {
    const before = app.windows().length;
    await page.getByRole('button', { name: 'Pop out Vault', exact: true }).click();
    await page.getByRole('button', { name: 'Bring Vault back', exact: true }).first().waitFor();
    if (app.windows().length <= before) throw new Error('no new window');
    await page.getByRole('button', { name: 'Bring Vault back', exact: true }).first().click();
    await page.getByRole('button', { name: 'Pop out Vault', exact: true }).waitFor();
  });
  await check('Leave hangs up and Join voice comes back in the bottom bar', async () => {
    await dock(page).getByRole('button', { name: 'Leave voice', exact: true }).click();
    await page.locator('.lcars-bottom').getByRole('button', { name: 'Join voice', exact: true }).waitFor();
    await settle(page);
    await shoot('13-left-call');
    await page.locator('.lcars-bottom').getByRole('button', { name: 'Join voice', exact: true }).click();
    await dock(page).getByRole('button', { name: 'Leave voice', exact: true }).waitFor();
  });
  await check('switching to the Tabs layout removes the frame and brings the title bar back', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Tabs', exact: true }).check();
    await page.locator('[data-layout="tabs"]').waitFor();
    if (await page.locator('[data-layout="lcars"]').count()) throw new Error('frame still there');
    await dialog.getByRole('radio', { name: 'LCARS', exact: true }).check();
    await page.locator('[data-layout="lcars"]').waitFor();
    const skin = await page.evaluate(() => document.documentElement.dataset.skin);
    if (skin !== 'lcars') throw new Error(`skin is ${skin}`);
  });
  return problems;
}

// The Orbit frame's own behaviour.
async function orbitOnly(page: Page, app: Awaited<ReturnType<typeof launch>>['app'], shoot: (name: string) => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const check = async (what: string, step: () => Promise<unknown>) => {
    try { await step(); } catch (err) { problems.push(`${what}: ${(err as Error).message.split('\n')[0]}`); }
  };
  await check('the app title bar is hidden behind the top bar', async () => {
    if (await page.locator('.cw-titlebar').isVisible()) throw new Error('title bar still showing');
  });
  await check('window buttons sit in the top bar', async () => {
    for (const name of ['Minimize', 'Maximize', 'Close']) await page.locator('.orbit-shell .cw-tabs-bar').getByRole('button', { name, exact: true }).waitFor({ timeout: 2000 });
  });
  await check('the line drawing is behind the layout', async () => {
    await page.locator('.orbit-backdrop').waitFor({ state: 'attached', timeout: 2000 });
  });
  await check('clicks reach the buttons on a voice tile (fullscreen, theater mode)', async () => {
    await tab(page, 'Voice').click();
    await page.locator('.cv-tile-frame').first().waitFor({ timeout: 5000 });
    // A stream's buttons sit in the tile's top corner, under the drawn corner brackets: a click there must land in the tile.
    const blocked = await page.locator('.cv-tile-frame').evaluateAll((frames) => frames.filter((f) => {
      const r = f.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 12, r.top + 12);
      return !hit || !f.contains(hit);
    }).length);
    if (blocked) throw new Error(`${blocked} tile(s) have their top corner covered`);
  });
  await check('the Glyph icons show', async () => {
    const shown = await page.locator('.cw-tabs .cw-ic-glyph').first().evaluate((el) => getComputedStyle(el).display);
    if (shown === 'none') throw new Error('glyph icons hidden');
  });
  await check('Alt+Right moves a tab along the bar', async () => {
    await tab(page, 'Text').focus();
    await page.keyboard.press('Alt+ArrowRight');
    const order = await page.locator('.orbit-shell [data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    if (order[0] !== 'voice' || order[1] !== 'text') throw new Error(`order is ${order.join(',')}`);
    await page.keyboard.press('Alt+ArrowLeft');
  });
  await check('a tab pops out into its own window and comes back', async () => {
    const before = app.windows().length;
    await page.getByRole('button', { name: 'Pop out Vault', exact: true }).click();
    await page.getByRole('button', { name: 'Bring Vault back', exact: true }).first().waitFor();
    if (app.windows().length <= before) throw new Error('no new window');
    await page.getByRole('button', { name: 'Bring Vault back', exact: true }).first().click();
    await page.getByRole('button', { name: 'Pop out Vault', exact: true }).waitFor();
  });
  await check('switching to the Tabs layout removes the frame and brings the title bar back', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Tabs', exact: true }).check();
    await page.locator('[data-layout="tabs"]').waitFor();
    if (await page.locator('[data-layout="orbit"]').count()) throw new Error('frame still there');
    await dialog.getByRole('radio', { name: 'Orbit', exact: true }).check();
    await page.locator('[data-layout="orbit"]').waitFor();
    const skin = await page.evaluate(() => document.documentElement.dataset.skin);
    if (skin !== 'orbit') throw new Error(`skin is ${skin}`);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  });
  await check('light mode', async () => {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await settle(page);
    await shoot('13-light');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  });
  return problems;
}

const args = process.argv.slice(2);
const layoutArg = args.find((a) => a.startsWith('--layout='))?.slice('--layout='.length) ?? 'lcars';
const [outArg, appArg] = args.filter((a) => !a.startsWith('--'));
const NAME = layoutArg === 'orbit' ? 'Orbit' : 'LCARS';
const outDir = path.resolve(outArg ?? `out/${layoutArg}`);
const appDir = path.resolve(appArg ?? DEFAULT_APP_DIR);
fs.rmSync(outDir, { recursive: true, force: true });

const tabs = await run('tabs', 'lebserver', appDir, outDir);
const lcars = await run(layoutArg, layoutArg, appDir, outDir);
const problems = [...tabs.problems.map((p) => `tabs: ${p}`), ...lcars.problems];
for (const screen of Object.keys(tabs.screens)) {
  for (const control of missingFrom(tabs.screens[screen], lcars.screens[screen] ?? [])) problems.push(`${screen}: missing in ${NAME}: ${control}`);
}
const added = Object.keys(lcars.screens).flatMap((s) => missingFrom(lcars.screens[s], tabs.screens[s] ?? []).map((c) => `${s}: ${c}`));
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ problems, addedInLcars: added, screens: { tabs: tabs.screens, lcars: lcars.screens } }, null, 2));
console.log(`${NAME} adds (fine): ${added.length ? `\n  ${added.join('\n  ')}` : 'nothing'}`);
if (problems.length) {
  console.error(`${NAME} check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`${NAME} keeps every control of the Tabs layout, and its frame works.`);
