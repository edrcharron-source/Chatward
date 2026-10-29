import fs from 'node:fs';
import { config } from './config.js';

// A home server is more likely than a cloud VM to fill a disk unnoticed, and SQLite and uploads fail in confusing ways
// when it happens. Say so plainly in the log at startup and once an hour.
const CHECK_EVERY_MS = 60 * 60_000;
const WARN_USED_PERCENT = 85;
const WARN_FREE_BYTES = 2 * 1024 ** 3;

function describe(label: string, dir: string): void {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    console.error(`[disk] ${label} folder ${dir} is not writable by the server. Check its owner and permissions.`);
    return;
  }
  const s = fs.statfsSync(dir);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const usedPercent = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  const line = `[disk] ${label} ${dir}: ${gb(free)} GB free of ${gb(total)} GB (${usedPercent}% used)`;
  if (usedPercent >= WARN_USED_PERCENT || free < WARN_FREE_BYTES) console.warn(`${line}. Running low: free some space soon.`);
  else console.log(line);
}

export function startDiskCheck(): void {
  const run = () => {
    describe('data', config.dataDir);
    describe('uploads', config.uploadsDir);
  };
  run();
  setInterval(run, CHECK_EVERY_MS).unref();
}
