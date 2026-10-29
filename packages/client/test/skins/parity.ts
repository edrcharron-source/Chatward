// Feature parity for skins (docs/SKINS.md): every skin must reach every feature in inventory.ts, enabled and clickable,
// and must show the same controls as the base skin on every screen. Runs the built app in demo mode, so it needs xvfb
// on Linux. Run with: npm run skins:parity -w @chatward/client -- <out dir> [app dir] [--broken]
// --broken runs the skins that are meant to fail, and exits 0 only if every one of them is caught.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { DEFAULT_APP_DIR, closePopups, launch, settle } from '../visual/harness';
import { FEATURES, SETTINGS_TABS, byId } from './inventory';

interface TestSkin {
  id: string;
  // A stylesheet under the package, scoped to :root[data-skin='<id>'] the way a real skin is.
  css?: string;
}

interface Run {
  results: Record<string, string>; // feature id -> 'ok' or why it could not be used
  fingerprints: Record<string, string[]>; // screen -> the visible controls, in DOM order
  problems: string[];
}

const BASE: TestSkin = { id: 'base' };
// Skins that must pass: a layout skin that moves every panel and changes nothing else.
const SKINS: TestSkin[] = [{ id: 'test-layout', css: 'test/skins/fixtures/test-layout.css' }];
// Skins that must fail: each one drops or hides something the check must notice.
const BROKEN_SKINS: TestSkin[] = [{ id: 'hides-action', css: 'test/skins/broken/hides-action.css' }];

const PROBE_MS = 3000;
// Every interactive control on screen, as a skin could leave it.
const CONTROLS = [
  'button', 'a[href]', 'input', 'select', 'textarea', '[role="button"]', '[role="tab"]', '[role="menuitem"]',
  '[role="switch"]', '[role="checkbox"]', '[role="option"]', '[role="textbox"]',
].join(', ');

async function controls(page: Page, screen: string, run: Run) {
  run.fingerprints[screen] = await page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => `${el.tagName.toLowerCase()}|${el.getAttribute('role') ?? ''}|${el.getAttribute('aria-label')
      ?? el.getAttribute('title') ?? el.textContent?.trim() ?? el.getAttribute('placeholder') ?? ''}`), CONTROLS);
}

// Checks one feature without changing anything: it must be the only match, visible and enabled, and must receive a
// click at its centre (a trial click runs the same checks and stops short of clicking).
async function probe(page: Page, id: string, run: Run) {
  try {
    const target = byId(id).find(page);
    await target.waitFor({ state: 'visible', timeout: PROBE_MS });
    if (!(await target.isEnabled())) throw new Error('disabled');
    await target.click({ trial: true, timeout: PROBE_MS });
    run.results[id] = 'ok';
  } catch (err) {
    // The first lines name the problem; the call log under them says what Playwright was waiting on.
    const lines = (err as Error).message.split('\n').map((line) => line.trim()).filter(Boolean);
    run.results[id] = `not usable: ${lines.slice(0, 6).join(' | ')}`;
  }
}

async function act(page: Page, id: string) {
  await byId(id).find(page).click({ timeout: PROBE_MS });
}

// The same walk for every skin: the auth screen, then the chat, its pickers, a member card, server settings and each
// settings tab. Screens are fingerprinted after the features on them are probed.
async function walk(page: Page, run: Run, shoot: (name: string) => Promise<void>) {
  await probe(page, 'auth.try-demo', run);
  await controls(page, 'auth', run);
  await shoot('auth');

  await act(page, 'auth.try-demo');
  await page.getByText('This is the start of #general').waitFor();
  for (const id of ['channel.create', 'server.settings', 'settings.open',
    'watch-party.toggle', 'chat.attach', 'chat.emoji', 'chat.gif', 'member.profile', 'channel.open-memes']) {
    await probe(page, id, run);
  }
  await page.getByLabel('Message', { exact: true }).fill('skin check');
  await probe(page, 'chat.message', run);
  await probe(page, 'chat.send', run);
  await page.getByLabel('Message', { exact: true }).fill('');
  await controls(page, 'chat', run);
  await shoot('chat');

  await act(page, 'channel.open-memes');
  await page.getByText('This is the start of #memes').waitFor();
  await page.getByRole('complementary', { name: 'Channels' }).getByText('general', { exact: true }).click();
  await page.getByText('This is the start of #general').waitFor();

  await act(page, 'chat.emoji');
  await probe(page, 'emoji-picker.dialog', run);
  await controls(page, 'emoji', run);
  await closePopups(page);

  await act(page, 'chat.gif');
  await probe(page, 'gif-picker.dialog', run);
  await probe(page, 'gif-picker.search', run);
  await controls(page, 'gif', run);
  await closePopups(page);

  await act(page, 'member.profile');
  await controls(page, 'profile', run);
  await closePopups(page);

  await act(page, 'server.settings');
  await probe(page, 'server-settings.dialog', run);
  await controls(page, 'server-settings', run);
  await closePopups(page);

  await act(page, 'settings.open');
  await probe(page, 'settings.dialog', run);
  for (const [tab] of SETTINGS_TABS) {
    await probe(page, `settings.tab-${tab}`, run);
    await act(page, `settings.tab-${tab}`);
    await controls(page, `settings-${tab}`, run);
    await shoot(`settings-${tab}`);
  }
  await probe(page, 'settings.close', run);
  await act(page, 'settings.close');
}

async function runSkin(skin: TestSkin, appDir: string, outDir: string): Promise<Run> {
  const run: Run = { results: {}, fingerprints: {}, problems: [] };
  const shotDir = path.join(outDir, skin.id);
  fs.mkdirSync(shotDir, { recursive: true });
  const shoot = async (name: string) => {
    await settle(page);
    await page.screenshot({ path: path.join(shotDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  };
  const { app, page } = await launch('dark', appDir);
  try {
    if (skin.css) {
      // Inserted by hand: the app's CSP blocks the connection Playwright's addStyleTag makes.
      const css = fs.readFileSync(path.join(DEFAULT_APP_DIR, skin.css), 'utf8');
      await page.evaluate(({ css, id }) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        document.documentElement.dataset.skin = id;
      }, { css, id: skin.id });
    }
    await walk(page, run, shoot);
  } catch (err) {
    run.problems.push(`walk stopped early: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    await app.close();
  }
  return run;
}

// Items in a that b does not have, counting repeats.
function missingFrom(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const item of b) left.set(item, (left.get(item) ?? 0) + 1);
  const out: string[] = [];
  for (const item of a) {
    const n = left.get(item) ?? 0;
    if (n > 0) left.set(item, n - 1);
    else out.push(item);
  }
  return out;
}

function judge(run: Run, base: Run): string[] {
  const problems = [...run.problems];
  for (const feature of FEATURES) {
    const result = run.results[feature.id];
    if (result === undefined) problems.push(`${feature.id}: never reached`);
    else if (result !== 'ok') problems.push(`${feature.id}: ${result}`);
  }
  for (const screen of new Set([...Object.keys(base.fingerprints), ...Object.keys(run.fingerprints)])) {
    const want = base.fingerprints[screen] ?? [];
    const got = run.fingerprints[screen] ?? [];
    for (const control of missingFrom(want, got)) problems.push(`${screen}: control missing: ${control}`);
    for (const control of missingFrom(got, want)) problems.push(`${screen}: control added: ${control}`);
  }
  return problems;
}

const argv = process.argv.slice(2);
const broken = argv.includes('--broken');
const [outArg, appArg] = argv.filter((arg) => !arg.startsWith('--'));
const outDir = path.resolve(outArg ?? 'out/skins');
const appDir = path.resolve(appArg ?? DEFAULT_APP_DIR);

const ids = FEATURES.map((f) => f.id);
if (new Set(ids).size !== ids.length) throw new Error('duplicate feature ids in test/skins/inventory.ts');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
console.log(`Checking skins of ${appDir} into ${outDir}`);

const base = await runSkin(BASE, appDir, outDir);
const report: Record<string, string[]> = { base: judge(base, base) };
let exitCode = report.base.length ? 1 : 0;

for (const skin of broken ? BROKEN_SKINS : SKINS) {
  const problems = judge(await runSkin(skin, appDir, outDir), base);
  report[skin.id] = problems;
  if (broken ? problems.length === 0 : problems.length > 0) exitCode = 1;
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
for (const [id, problems] of Object.entries(report)) {
  console.log(problems.length ? `${id}: ${problems.length} problem(s)` : `${id}: keeps every feature`);
  for (const problem of problems.slice(0, 40)) console.log(`  ${problem}`);
}
if (broken && exitCode === 0) console.log('Every broken skin was caught.');
if (broken && exitCode !== 0) console.error('A broken skin passed, or the base skin failed.');
process.exitCode = exitCode;
