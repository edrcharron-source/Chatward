// Checks the LCARS layout's see-through window (main/index.ts, components/lcars/shapedWindow.ts): picking LCARS swaps in a
// transparent window, the page paints nothing past the frame's outline (the corners stay fully see-through, even with a
// dialog open), the edges can resize it, and picking another layout brings the usual window back. Each switch moves the
// page to the new window as it is (no reload), so a typed draft and the page's own state carry over. Screenshots (on a pink
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

// Picks a layout in Settings > Appearance, the way a person does, and waits until the page is in the matching window.
// The page must not reload: it is moved to the new window as it is.
async function pickLayout(page: Page, layout: string, label: string, seamless = false) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await dialog.getByRole('radio', { name: label, exact: true }).check();
  await page.keyboard.press('Escape');
  const want = layout === 'lcars' || seamless;
  await page.waitForFunction((want) => window.chatward.windowControls.isShaped() === want, want);
  await page.waitForTimeout(400);
}

const windows = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
const capture = (app: ElectronApplication) => app.evaluate(async ({ webContents }) => {
  const page = webContents.getAllWebContents().find((w) => w.getURL().startsWith('app://'));
  return (await page!.capturePage()).toPNG().toString('base64');
}).then((b) => Buffer.from(b, 'base64'));

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
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    assert.equal(await page.evaluate(() => window.chatward.windowControls.isShaped()), false, 'starts in the usual window');
    await page.getByText('Try demo', { exact: false }).click();
    await page.getByLabel('Message', { exact: true }).waitFor();
    // Something only this run of the page has: it must still be there after each switch, so the page never reloaded.
    await page.evaluate(() => { (window as unknown as { stillHere: boolean }).stillHere = true; });
    const stillHere = () => page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere === true);
    await page.getByLabel('Message', { exact: true }).fill('half-typed draft');

    await pickLayout(page, 'lcars', 'LCARS');
    assert.equal(await windows(app), 1, 'the old window is gone after the switch');
    assert.equal(await stillHere(), true, 'switching to LCARS keeps the page running (no reload)');
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'half-typed draft', 'a typed draft survives the switch');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'window-frame.json'), 'utf8')), { shaped: true });

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

    await pickLayout(page, 'tabs', 'Tabs');
    assert.equal(await windows(app), 1, 'one window after switching back');
    assert.equal(await stillHere(), true, 'switching back from LCARS keeps the page running (no reload)');
    assert.deepEqual(alphaAt(await capture(app), corners), [255, 255, 255, 255], 'the usual window is solid');
    await pickLayout(page, 'orbit', 'Orbit');
    assert.equal(await stillHere(), true, 'switching to Orbit keeps the page running');

    // Seamless layout switching: every layout stays in the see-through window, so switching to and from LCARS never
    // changes the window at all. The rectangular layouts paint solid and draw their own resize edges.
    await pickLayout(page, 'tabs', 'Tabs');
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('switch', { name: /Seamless layout switching/ }).check();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.chatward.windowControls.isShaped() === true);
    await page.waitForTimeout(400);
    assert.equal(await stillHere(), true, 'turning Seamless layout switching on keeps the page running');
    const seamlessShot = await capture(app);
    onPink(seamlessShot, '3-tabs-seamless.png');
    assert.deepEqual(alphaAt(seamlessShot, corners), [255, 255, 255, 255], 'Tabs in the see-through window is solid');
    assert.equal(await page.locator('.cw-resize').count(), 8, 'Tabs in the see-through window has resize edges');
    const windowId = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((w) => w.id).join());
    const before = await windowId();
    await pickLayout(page, 'lcars', 'LCARS', true);
    assert.equal(await windowId(), before, 'switching to LCARS keeps the same window (no blink)');
    assert.equal(await page.locator('.cw-resize').count(), 0, 'LCARS draws its own edges instead');
    assert.equal(await page.locator('.lcars-resize').count(), 8, 'the LCARS frame has its resize edges');
    await pickLayout(page, 'orbit', 'Orbit', true);
    assert.equal(await windowId(), before, 'switching from LCARS to Orbit keeps the same window (no blink)');
    assert.deepEqual(alphaAt(await capture(app), corners), [255, 255, 255, 255], 'Orbit in the see-through window is solid');
    assert.equal(await stillHere(), true, 'the page never reloaded');
    console.log('LCARS gets a see-through window with nothing past its frame, other layouts keep the usual one, and Seamless layout switching keeps one window for all.');
  } finally {
    await app.close();
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
