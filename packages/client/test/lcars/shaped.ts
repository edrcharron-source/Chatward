// Checks the LCARS layout's see-through window (main/index.ts, components/lcars/shapedWindow.ts): picking LCARS swaps in a
// transparent window, the page paints nothing past the frame's outline (the corners stay fully see-through, even with a
// dialog open), the edges can resize it, and picking another layout brings the usual window back. Screenshots (on a pink
// backdrop, so the see-through parts show) land in the out dir.
// Needs xvfb on Linux. Run with: npm run lcars:shaped -w @chatward/client -- <out dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;
const out = path.resolve(process.argv[2] ?? 'out/lcars-shaped');
const appDir = path.resolve(import.meta.dirname, '../..');

function alphaAt(png: Buffer, points: [number, number][]): number[] {
  const img = PNG.sync.read(png);
  return points.map(([x, y]) => img.data[(img.width * y + x) * 4 + 3]);
}

function onPink(png: Buffer, file: string) {
  const img = PNG.sync.read(png);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    img.data[i] = Math.round(img.data[i] * a + 214 * (1 - a));
    img.data[i + 1] = Math.round(img.data[i + 1] * a + 120 * (1 - a));
    img.data[i + 2] = Math.round(img.data[i + 2] * a + 170 * (1 - a));
    img.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(out, file), PNG.sync.write(img));
}

async function pickLayout(app: ElectronApplication, page: Page, layout: string, skin: string): Promise<Page> {
  const next = app.waitForEvent('window');
  await page.evaluate(({ layout, skin }) => {
    const saved = JSON.parse(localStorage.getItem('chatward.settings') ?? '{}');
    localStorage.setItem('chatward.settings', JSON.stringify({ ...saved, layout, skin }));
    location.reload();
  }, { layout, skin });
  const win = await next;
  await win.waitForLoadState('load');
  return win;
}

const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const capture = (app: ElectronApplication) => app.evaluate(async ({ BrowserWindow }) =>
  (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')).then((b) => Buffer.from(b, 'base64'));

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(process.env.RUNNER_TEMP ?? '/tmp'), 'chatward-shaped-'));
  const app = await _electron.launch({ executablePath: electronPath, args: [appDir, `--user-data-dir=${userData}`, '--no-sandbox', '--force-device-scale-factor=1'] });
  try {
    await app.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (s: string) => Buffer.from(s);
      safeStorage.decryptString = (b: Buffer) => b.toString();
    });
    let page = await app.firstWindow();
    await page.waitForLoadState('load');
    assert.equal(await page.evaluate(() => window.chatward.windowControls.shaped), false, 'starts in the usual window');

    page = await pickLayout(app, page, 'lcars', 'lcars');
    assert.equal(await windows(app), 1, 'the old window is gone after the swap');
    assert.equal(await page.evaluate(() => window.chatward.windowControls.shaped), true, 'LCARS gets the see-through window');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'window-frame.json'), 'utf8')), { shaped: true });

    await page.getByText('Try demo', { exact: false }).click();
    await page.getByLabel('Message', { exact: true }).waitFor();
    // The real app has no demo banner, so the frame starts at the window's top edge.
    await page.addStyleTag({ content: '.cw-app > *:not(.cw-app-body) { display: none !important; }' });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.lcars-resize').count(), 8, 'the frame has resize edges');
    const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const corners: [number, number][] = [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]];
    const shot = await capture(app);
    onPink(shot, '1-lcars-see-through.png');
    assert.deepEqual(alphaAt(shot, corners), [0, 0, 0, 0], 'the four corners are see-through');
    assert.deepEqual(alphaAt(shot, [[200, 15], [Math.round(width / 2), Math.round(height / 2)]]), [255, 255], 'the frame and the content are solid');

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(600);
    const dialog = await capture(app);
    onPink(dialog, '2-lcars-settings-open.png');
    assert.deepEqual(alphaAt(dialog, corners), [0, 0, 0, 0], 'a dialog backdrop does not fill the corners');
    await page.keyboard.press('Escape');

    page = await pickLayout(app, page, 'tabs', 'lebserver');
    assert.equal(await page.evaluate(() => window.chatward.windowControls.shaped), false, 'other layouts get the usual window back');
    assert.deepEqual(alphaAt(await capture(app), corners), [255, 255, 255, 255], 'the usual window is solid');
    console.log('LCARS gets a see-through window with nothing past its frame, and other layouts keep the usual one.');
  } finally {
    await app.close();
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
