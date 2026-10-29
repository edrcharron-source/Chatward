// Compares two folders of screenshots from capture.ts and fails if any pixel of any screen changed.
// Run with: npm run visual:compare -w @chatward/client -- <before dir> <after dir> [diff dir]
// Changed pixels are drawn in red into the diff dir so they can be reviewed.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// Chromium's rasteriser is not bit-exact between runs: anti-aliased edges (round avatars, emoji) wobble by up to 3
// in a colour channel. A change too small to clear this is too small to see.
const NOISE = 4;

interface Diff { changed: number; maxDelta: number; box: [number, number, number, number] }

function diffPixels(a: PNG, b: PNG, out: PNG): Diff {
  const d: Diff = { changed: 0, maxDelta: 0, box: [a.width, a.height, -1, -1] };
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
    const moved = delta > NOISE;
    if (moved) {
      const x = (i / 4) % a.width;
      const y = Math.floor(i / 4 / a.width);
      d.changed++;
      d.maxDelta = Math.max(d.maxDelta, delta);
      d.box = [Math.min(d.box[0], x), Math.min(d.box[1], y), Math.max(d.box[2], x), Math.max(d.box[3], y)];
    }
    const grey = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 12 + 170;
    out.data.set(moved ? [255, 0, 0, 255] : [grey, grey, grey, 255], i);
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
