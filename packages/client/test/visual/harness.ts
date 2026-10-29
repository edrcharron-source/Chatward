// Shared by the screenshot check (capture.ts) and the skin feature check (test/skins/parity.ts): launches the built
// app in demo mode with every input that could change between runs pinned. See docs/SKINS.md.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;

export const SIZE = { width: 1280, height: 800 };
export const DEFAULT_APP_DIR = path.resolve(import.meta.dirname, '../..');

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

export async function launch(theme: string, appDir: string): Promise<{ app: ElectronApplication; page: Page }> {
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

export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  });
  await page.waitForTimeout(400);
}

export async function closePopups(page: Page) {
  await page.keyboard.press('Escape');
  await page.mouse.click(5, SIZE.height - 5);
  await page.waitForTimeout(150);
}
