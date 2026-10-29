// Screenshots of the built client in demo mode, for the "looks exactly the same" check (docs/SKINS.md).
// Run with: npm run visual:capture -w @chatward/client -- <out dir> [app dir]
// The app dir defaults to this package; pass another checkout's packages/client to capture its build instead.
// On Linux run it under xvfb-run. The launch and pinning live in harness.ts, shared with the skin feature check.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { DEFAULT_APP_DIR, closePopups, launch, settle } from './harness';

const outDir = path.resolve(process.argv[2] ?? 'out/visual/shots');
const appDir = path.resolve(process.argv[3] ?? DEFAULT_APP_DIR);
const THEMES = ['dark', 'light'] as const;

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

async function captureTheme(theme: string) {
  const { app, page } = await launch(theme, appDir);
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
