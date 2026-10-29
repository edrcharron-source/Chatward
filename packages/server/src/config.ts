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

/** Per-person upload quota. 1 GB each keeps seven people well inside the Lightsail disk. */
function uploadQuotaBytes(): number {
  const raw = process.env.UPLOAD_QUOTA_MB ?? '1024';
  const mb = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(mb) || mb < 0) {
    throw new Error('UPLOAD_QUOTA_MB must be a number of megabytes (0 turns the limit off).');
  }
  return Math.round(mb * 1024 * 1024);
}

function megabytes(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  const mb = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(mb) || mb < 0) throw new Error(`${name} must be a number of megabytes.`);
  return Math.round(mb * 1024 * 1024);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'chatward.db'),
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? path.join(dataDir, 'uploads')),
  /** Total upload storage each person may keep, in bytes. 0 turns the limit off. Set UPLOAD_QUOTA_MB to change it. */
  uploadQuotaBytes: uploadQuotaBytes(),
  /** Vault photos and videos. Point VAULT_DIR at bulk storage (the RAID on the home server). */
  vaultDir: path.resolve(process.env.VAULT_DIR ?? path.join(dataDir, 'vault')),
  /** Vault space each person may use, in bytes (VAULT_QUOTA_MB, default 20 GB). 0 turns the limit off. */
  vaultQuotaBytes: megabytes('VAULT_QUOTA_MB', '20480'),
  /** Largest single Vault upload, in bytes (VAULT_MAX_MB, default 200 MB). Uploads are held in memory while they arrive. */
  vaultMaxBytes: megabytes('VAULT_MAX_MB', '200'),
  /** Desktop installer, latest.yml and blockmap, served at /updates for the client auto-updater. */
  updatesDir: path.resolve(process.env.UPDATES_DIR ?? path.join(dataDir, 'updates')),
  /** Set by the update script from the installed release tag. */
  serverVersion: process.env.CHATWARD_VERSION ?? '0.0.0-dev',
  /** The address people put in the app, shown in the message `chatward invite` prints. */
  publicUrl: process.env.PUBLIC_URL ?? '',
  /** Clients older than this are blocked until they update. */
  minClientVersion: process.env.MIN_CLIENT_VERSION ?? '0.0.0',
  /**
   * Set to 1 only when a reverse proxy (Caddy) is in front of the server. Otherwise clients could send their own
   * X-Forwarded-For header and dodge the login rate limit.
   */
  trustProxy: process.env.TRUST_PROXY === '1',
  jwtSecret: jwtSecret(),
  klipyApiKey: process.env.KLIPY_API_KEY ?? '',
  /** Jellyfin library for the movie browser. All three must be set to turn it on; see docs/HOME_SERVER.md. */
  jellyfin: {
    url: (process.env.JELLYFIN_URL ?? '').replace(/\/$/, ''),
    apiKey: process.env.JELLYFIN_API_KEY ?? '',
    /** The dedicated Jellyfin user whose library the group sees. */
    userId: (process.env.JELLYFIN_USER_ID ?? '').replace(/-/g, ''),
  },
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
fs.mkdirSync(config.vaultDir, { recursive: true });
fs.mkdirSync(config.updatesDir, { recursive: true });
