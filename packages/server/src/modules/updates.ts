import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import express from 'express';
import type { VersionInfo } from '@chatward/shared';
import { config } from '../config.js';
import type { Ctx } from '../ctx.js';

// electron-builder writes `version:` as the first field of latest.yml; the release step uploads that file.
function latestClientVersion(): string | null {
  try {
    const m = /^version:\s*(\S+)/m.exec(fs.readFileSync(path.join(config.updatesDir, 'latest.yml'), 'utf8'));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function register(app: Express, _ctx: Ctx): void {
  // Public on purpose: the desktop updater fetches these without a login. Only release artifacts live in this folder.
  app.use('/updates', express.static(config.updatesDir, { dotfiles: 'ignore', index: false }));

  // Public so a too-old client can learn it must update before it logs in.
  app.get('/api/version', (_req, res) => {
    const info: VersionInfo = {
      serverVersion: config.serverVersion,
      minClientVersion: config.minClientVersion,
      latestClientVersion: latestClientVersion(),
    };
    res.json(info);
  });
}
