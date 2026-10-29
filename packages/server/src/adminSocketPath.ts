import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Where the server's admin socket lives for a data folder. Kept apart from modules/admin.ts so the CLI can find it
 * without loading the server. Windows has no socket files, so a dev server there uses a named pipe instead.
 */
export function adminSocketPathFor(dataDir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\chatward-admin-${crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`;
  }
  return path.join(dataDir, 'admin.sock');
}
