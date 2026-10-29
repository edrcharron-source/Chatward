// Compares two folders of screenshots from capture.ts and fails if any pixel of any screen changed.
// Run with: npm run visual:compare -w @chatward/client -- <before dir> <after dir> [diff dir]
// Changed pixels are drawn in red into the diff dir so they can be reviewed.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// Chromium's rasteriser is not bit-exact between runs, even for the same build:
// - anti-aliased edges (round avatars, emoji) wobble by up to 3 in a colour channel;
// - on CI runners, the sub-pixel edge of a box sometimes flips, leaving a one-pixel-wide sliver a few pixels long.
// A changed area counts when it holds a 2x2 block of changed pixels or is SLIVER pixels or longer, so a real change,
// even a 1px border recoloured, is still caught.
const NOISE = 4;
const SLIVER = 40;

interface Diff { changed: number; maxDelta: number; box: [number, number, number, number] }

function diffPixels(a: PNG, b: PNG, out: PNG): Diff {
  const { width, height } = a;
  const delta = new Uint8Array(width * height);
  for (let p = 0; p < delta.length; p++) {
    const i = p * 4;
    delta[p] = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
  }
  const moved = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && delta[y * width + x] > NOISE;

  // Group changed pixels into 8-connected areas and keep the areas that are more than noise.
  const real = new Uint8Array(width * height);
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < delta.length; start++) {
    if (seen[start] || delta[start] <= NOISE) continue;
    const area: number[] = [start];
    seen[start] = 1;
    let block = false;
    for (let k = 0; k < area.length; k++) {
      const x = area[k] % width;
      const y = Math.floor(area[k] / width);
      if (moved(x + 1, y) && moved(x, y + 1) && moved(x + 1, y + 1)) block = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = (y + dy) * width + x + dx;
        if (moved(x + dx, y + dy) && !seen[n]) { seen[n] = 1; area.push(n); }
      }
    }
    if (block || area.length >= SLIVER) for (const n of area) real[n] = 1;
  }

  const d: Diff = { changed: 0, maxDelta: 0, box: [width, height, -1, -1] };
  for (let p = 0; p < real.length; p++) {
    const i = p * 4;
    if (real[p]) {
      const x = p % width;
      const y = Math.floor(p / width);
      d.changed++;
      d.maxDelta = Math.max(d.maxDelta, delta[p]);
      d.box = [Math.min(d.box[0], x), Math.min(d.box[1], y), Math.max(d.box[2], x), Math.max(d.box[3], y)];
    }
    const grey = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 12 + 170;
    out.data.set(real[p] ? [255, 0, 0, 255] : [grey, grey, grey, 255], i);
  }
  return d;
}

const [beforeDir, afterDir, diffDir = 'out/visual/diff'] = process.argv.slice(2).map((d) => path.resolve(d));
if (!beforeDir || !afterDir) {
  console.error('usage: compare <before dir> <after dir> [diff dir]');
  process.exit(2);
}

const names = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
const before = names(beforeDir);
const after = names(afterDir);
const problems: string[] = [];

for (const name of before.filter((n) => !after.includes(n))) problems.push(`${name}: missing from ${afterDir}`);
for (const name of after.filter((n) => !before.includes(n))) problems.push(`${name}: missing from ${beforeDir}`);

fs.rmSync(diffDir, { recursive: true, force: true });
for (const name of before.filter((n) => after.includes(n))) {
  const a = PNG.sync.read(fs.readFileSync(path.join(beforeDir, name)));
  const b = PNG.sync.read(fs.readFileSync(path.join(afterDir, name)));
  if (a.width !== b.width || a.height !== b.height) {
    problems.push(`${name}: size changed from ${a.width}x${a.height} to ${b.width}x${b.height}`);
    continue;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const { changed, maxDelta, box } = diffPixels(a, b, diff);
  if (changed > 0) {
    fs.mkdirSync(diffDir, { recursive: true });
    fs.writeFileSync(path.join(diffDir, name), PNG.sync.write(diff));
    problems.push(`${name}: ${changed} pixels differ, by up to ${maxDelta}, within x ${box[0]}-${box[2]}, y ${box[1]}-${box[3]}`);
  } else {
    console.log(`  same  ${name}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`  DIFF  ${p}`);
  // In GitHub Actions, also raise each as an annotation so it shows on the pull request's checks page.
  if (process.env.GITHUB_ACTIONS) for (const p of problems) console.log(`::error title=Screen changed::${p}`);
  console.error(`${problems.length} screen(s) changed. Diff images: ${diffDir}`);
  process.exit(1);
}
console.log(`All ${before.length} screens match.`);
