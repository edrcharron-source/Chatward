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

const SETUP_CODE_FILE = path.join(dataDir, 'setup-code');
// Same look-alike-free alphabet as the reset codes, so a code copied by hand is unambiguous.
const SETUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The code the first account must enter. Set SETUP_CODE in .env to choose it. Otherwise a random one is made the first
 * time it is needed, kept in the data folder until the first account exists, and printed to the server log.
 */
export function setupCode(): string {
  const fromEnv = process.env.SETUP_CODE?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(SETUP_CODE_FILE)) return fs.readFileSync(SETUP_CODE_FILE, 'utf8').trim();
  const chars = [...crypto.randomBytes(12)].map((b) => SETUP_CODE_ALPHABET[b % 32]).join('');
  const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  fs.writeFileSync(SETUP_CODE_FILE, code, { mode: 0o600 });
  console.log(`First account setup code (enter it when you register the first account): ${code}`);
  return code;
}

/** Forgets the generated code once the first account exists. A code set in .env is not touched. */
export function clearSetupCode(): void {
  fs.rmSync(SETUP_CODE_FILE, { force: true });
}

/** LiveKit keys. The dev defaults are public, so production refuses to start with them. */
function livekitKeys(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      throw new Error('Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env before starting the server.');
    }
    if (apiKey === 'devkey' || apiSecret === 'secret') {
      throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET are still the public defaults. Replace them (see docs/UPDATES.md).');
    }
    if (apiSecret.length < 32) {
      throw new Error('LIVEKIT_API_SECRET must be at least 32 characters.');
    }
  }
  return { apiKey, apiSecret };
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
  /**
   * Set to 1 only when a reverse proxy (Caddy) is in front of the server. Otherwise clients could send their own
   * X-Forwarded-For header and dodge the login rate limit.
   */
  trustProxy: process.env.TRUST_PROXY === '1',
  jwtSecret: jwtSecret(),
  klipyApiKey: process.env.KLIPY_API_KEY ?? '',
  livekit: {
    url: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    /**
     * Server-side API (kick from a room) speaks HTTP. Set LIVEKIT_API_URL when the server reaches LiveKit by another
     * address than the clients do, e.g. inside Docker (http://livekit:7880). Otherwise the ws:// URL is mapped to http://.
     */
    apiUrl: process.env.LIVEKIT_API_URL ?? (process.env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http'),
    ...livekitKeys(),
  },
};
fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(config.updatesDir, { recursive: true });
