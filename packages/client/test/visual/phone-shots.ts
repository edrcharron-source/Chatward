// Phone-size screenshots of the text chat's message box and its emoji/GIF pickers in each skin, for reviewing the phone
// layout by eye. Run with: npm run phone:shots -w @chatward/client -- <out dir>   (on Linux under xvfb-run)
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launch, settle } from './harness';

const outDir = path.resolve(process.argv[2] ?? 'out/visual/phone');
const SKINS = (process.env.CHATWARD_PHONE_SKINS ?? 'lebserver,,retro-ascii,lcars,orbit').split(',');
const PHONE = { width: 390, height: 844 };

async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  console.log(`  ${name}`);
}

fs.mkdirSync(outDir, { recursive: true });
for (const skin of SKINS) {
  const { app, page } = await launch('dark', path.resolve(import.meta.dirname, '../..'), skin);
  const name = skin || 'original';
  try {
    await page.setViewportSize(PHONE);
    await page.getByText('Try demo').click();
    await page.getByPlaceholder(/Message #/).waitFor();
    await page.waitForTimeout(600);
    await shot(page, `${name}-1-chat`);
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    await page.getByRole('dialog', { name: /Emoji/ }).waitFor();
    await page.waitForTimeout(1000);
    await shot(page, `${name}-2-emoji`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.getByRole('dialog', { name: /GIF/ }).waitFor();
    await page.waitForTimeout(800);
    await shot(page, `${name}-3-gif`);
  } finally {
    await app.close();
  }
}
