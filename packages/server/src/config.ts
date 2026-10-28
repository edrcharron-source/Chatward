import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
fs.mkdirSync(dataDir, { recursive: true });

function jwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Local-dev convenience: persist a generated secret so tokens survive restarts.
  const f = path.join(dataDir, 'jwt-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'chatward.db'),
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? path.join(dataDir, 'uploads')),
  /** Desktop installer, latest.yml and blockmap, served at /updates for the client auto-updater. */
  updatesDir: path.resolve(process.env.UPDATES_DIR ?? path.join(dataDir, 'updates')),
  /** Set by the update script from the installed release tag. */
  serverVersion: process.env.CHATWARD_VERSION ?? '0.0.0-dev',
  /** Clients older than this are blocked until they update. */
  minClientVersion: process.env.MIN_CLIENT_VERSION ?? '0.0.0',
  jwtSecret: jwtSecret(),
  klipyApiKey: process.env.KLIPY_API_KEY ?? '',
  livekit: {
    url: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    /** Server-side API (kick from a room) speaks HTTP, so the ws:// URL is mapped to http://. */
    apiUrl: (process.env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http'),
    apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
    apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret',
  },
};
fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(config.updatesDir, { recursive: true });
