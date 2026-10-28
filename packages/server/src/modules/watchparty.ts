import type { Express } from 'express';
import { LIMITS } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';

// Latest watch-party snapshot per channel. The server never reads it: the body is the client-encrypted
// playback state, so a relayed snapshot is opaque ciphertext. In memory, so a restart means nothing is playing.
interface Snapshot {
  ciphertext: string;
  keyVersion: number;
  authorId: string;
  ts: number; // server ms when it was accepted; clients use it to project the playhead forward
}

const snapshots = new Map<string, Snapshot>();

// Called when a channel is deleted, so its last snapshot does not stay in memory for the life of the process.
export function forgetWatchParty(channelId: string): void {
  snapshots.delete(channelId);
}

export function register(app: Express, ctx: Ctx): void {
  // Any member of the channel's server can read and set the shared playback state, same as posting a message.
  app.get('/api/channels/:id/watch', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    if (!ctx.serverIdForChannelMember(req.params.id, userId)) { res.status(404).json({ error: 'channel not found' }); return; }
    res.json({ state: snapshots.get(req.params.id) ?? null, serverNow: Date.now() });
  });

  app.post('/api/channels/:id/watch', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = req.params.id;
    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    if (!serverId) { res.status(404).json({ error: 'channel not found' }); return; }

    const { ciphertext, keyVersion } = (req.body ?? {}) as { ciphertext?: unknown; keyVersion?: unknown };
    if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > LIMITS.MESSAGE_CIPHERTEXT_MAX) {
      res.status(400).json({ error: 'invalid ciphertext' }); return;
    }
    if (!Number.isInteger(keyVersion) || (keyVersion as number) < 1) { res.status(400).json({ error: 'invalid keyVersion' }); return; }

    const snapshot: Snapshot = { ciphertext, keyVersion: keyVersion as number, authorId: userId, ts: Date.now() };
    snapshots.set(channelId, snapshot);
    ctx.broadcastToServer(serverId, { t: 'watch.sync', channelId, ...snapshot });
    res.json({ ok: true, ts: snapshot.ts });
  });
}
