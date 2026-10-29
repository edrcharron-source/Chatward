import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
const [b, a] = process.argv.slice(2);
const jobs = [
  ['light-chat-general.png', 300, 60, 700, 130], ['light-chat-general.png', 330, 700, 1030, 800],
  ['light-chat-general.png', 72, 90, 312, 300], ['dark-settings-security.png', 440, 520, 640, 680],
  ['light-profile-card.png', 900, 90, 1279, 500],
];
for (const [name, x0, y0, x1, y1] of jobs) {
  const A = PNG.sync.read(fs.readFileSync(path.join(b, name)));
  const B = PNG.sync.read(fs.readFileSync(path.join(a, name)));
  const w = x1 - x0, h = y1 - y0;
  const out = new PNG({ width: w, height: h * 2 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y0 + y) * A.width + x0 + x) * 4;
    for (let c = 0; c < 4; c++) { out.data[(y * w + x) * 4 + c] = A.data[s + c]; out.data[((y + h) * w + x) * 4 + c] = B.data[s + c]; }
  }
  const b64 = PNG.sync.write(out).toString('base64');
  for (let i = 0; i < b64.length; i += 60000) console.log(`::warning title=crop ${name} ${x0},${y0} part ${i / 60000}::${b64.slice(i, i + 60000)}`);
}
