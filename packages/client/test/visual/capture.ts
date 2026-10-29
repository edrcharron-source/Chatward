// Screenshots of the built client in demo mode, for the "looks exactly the same" check (docs/SKINS.md).
// Run with: npm run visual:capture -w @chatward/client -- <out dir> [app dir]
// The app dir defaults to this package; pass another checkout's packages/client to capture its build instead.
// On Linux run it under xvfb-run. Every input that could change between runs is pinned: the clock, Math.random,
// time zone, locale, window size, link previews, and the demo bots' delayed chatter.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;

const outDir = path.resolve(process.argv[2] ?? 'out/visual/shots');
const appDir = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '../..'));
const THEMES = ['dark', 'light'] as const;
const SIZE = { width: 1280, height: 800 };

// Runs in the page before the app's own code. Timers of 5 s or more are held, which keeps the demo bots from
// typing or posting mid-capture; nothing the screens below show depends on a timer that long.
const pinPage = (theme: string) => `(() => {
  const FIXED = Date.UTC(2026, 0, 15, 18, 0, 0);
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(FIXED); }
    static now() { return FIXED; }
  }
  globalThis.Date = FixedDate;
  let seed = 0x2f6b1d;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => (Number(ms) >= 5000 ? 0 : realSetTimeout(fn, ms, ...rest));
  localStorage.setItem('chatward.settings', JSON.stringify({ theme: ${JSON.stringify(theme)} }));
})();`;

async function launch(theme: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(process.env.RUNNER_TEMP ?? '/tmp'), 'chatward-visual-'));
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [appDir, `--user-data-dir=${userData}`, '--no-sandbox', '--lang=en-US', '--force-device-scale-factor=1'],
    env: { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8' },
  });
  // CI machines have no OS keyring. Stand in for it so demo sign-in can store its keys; nothing here is real.
  // Link previews are answered with a fixed card instead of the live page.
  await app.evaluate(({ safeStorage, ipcMain }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (s: string) => Buffer.from(s);
    safeStorage.decryptString = (b: Buffer) => b.toString();
    ipcMain.removeHandler('demo:linkpreview');
    ipcMain.handle('demo:linkpreview', (_e, url: string) => ({
      status: 200, body: { url, title: 'Example page', description: 'A fixed preview used for screenshots.', siteName: 'example.com' },
    }));
  });
  const page = await app.firstWindow();
  await page.context().addInitScript(pinPage(theme));
  await page.setViewportSize(SIZE);
  await page.reload();
  await page.waitForLoadState('load');
  return { app, page };
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  });
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string) {
  await settle(page);
  // Demo GIFs are animated SVGs that CSS can't pause, so their box is painted one flat colour: its size, place and
  // rounding are still compared, the animation frame is not.
  await page.screenshot({
    path: path.join(outDir, `${name}.png`), animations: 'disabled', caret: 'hide',
    mask: [page.locator('img.media-gif')], maskColor: '#ff00ff',
  });
  console.log(`  ${name}`);
}

async function closePopups(page: Page) {
  await page.keyboard.press('Escape');
  await page.mouse.click(5, SIZE.height - 5);
  await page.waitForTimeout(150);
}

async function captureTheme(theme: string) {
  const { app, page } = await launch(theme);
  try {
    const p = (name: string) => `${theme}-${name}`;
    await shot(page, p('auth'));

    await page.getByText('Try demo').click();
    await page.getByRole('heading', { name: 'general' }).or(page.getByText('This is the start of #general')).first().waitFor();
    await shot(page, p('chat-general'));

    for (const channel of ['memes', 'watch-party']) {
      await page.getByRole('complementary', { name: 'Channels' }).getByText(channel, { exact: true }).click();
      await page.getByText(`This is the start of #${channel}`).waitFor();
      await shot(page, p(`chat-${channel}`));
    }
    await page.getByRole('complementary', { name: 'Channels' }).getByText('general', { exact: true }).click();
    await page.getByText('This is the start of #general').waitFor();

    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    await page.getByRole('dialog', { name: 'Emoji picker' }).waitFor();
    await page.waitForTimeout(800);
    await shot(page, p('emoji-picker'));
    await closePopups(page);

    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.getByRole('dialog', { name: 'GIF picker' }).waitFor();
    await shot(page, p('gif-picker'));
    await closePopups(page);

    await page.getByRole('complementary', { name: 'Members' }).getByText('Avery').click();
    await shot(page, p('profile-card'));
    await closePopups(page);

    await page.getByRole('button', { name: 'Server settings' }).click();
    await shot(page, p('server-settings'));
    await closePopups(page);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    for (const tab of ['Account', 'Appearance', 'Notifications', 'Privacy', 'Security']) {
      await settings.getByRole('tab', { name: tab }).click();
      await shot(page, p(`settings-${tab.toLowerCase()}`));
    }
  } finally {
    await app.close();
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
console.log(`Capturing ${appDir} into ${outDir}`);
for (const theme of THEMES) await captureTheme(theme);
