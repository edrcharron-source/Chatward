import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { LIMITS, type SoundboardSound } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';
import { isInVoiceChannel } from './voice.js';

const SOUNDS_PER_SERVER = 100;
const NAME_MAX = 32;
const EMOJI_MAX = 16;

type SoundRow = {
  id: string;
  server_id: string;
  owner_id: string;
  name: string;
  emoji: string;
  mime: string;
  duration_ms: number;
};

/** Identifies the container from its leading bytes; the client's Content-Type is not trusted. */
function sniffAudio(b: Buffer): string | null {
  const ascii = (start: number, end: number) => b.subarray(start, end).toString('ascii');
  if (b.length < 12) return null;
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (b.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return 'audio/mpeg'; // MPEG frame sync
  return null;
}

export function register(app: Express, ctx: Ctx): void {
  const soundsDir = path.join(ctx.config.dataDir, 'sounds');
  fs.mkdirSync(soundsDir, { recursive: true });
  const filePath = (id: string) => path.join(soundsDir, id);
  const { db } = ctx;

  const toSound = (r: SoundRow): SoundboardSound => ({
    id: r.id,
    serverId: r.server_id,
    ownerId: r.owner_id,
    name: r.name,
    emoji: r.emoji,
    url: `/api/sounds/${r.id}/file`,
    durationMs: r.duration_ms,
  });
  const soundById = (id: string) => db.prepare('SELECT * FROM sounds WHERE id=?').get(id) as SoundRow | undefined;

  const requireMember = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.roleIn(req.params.id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'server not found' }); return; }
    next();
  };

  // Route-scoped parser: a body-size overflow answers 413 instead of falling through to the global 500.
  const audioBody = express.raw({ type: 'audio/*', limit: LIMITS.SOUND_MAX_BYTES });
  const readAudio = (req: Request, res: Response, next: NextFunction) =>
    audioBody(req, res, (err?: Error & { status?: number }) => {
      if (err) { res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? 'sound too large' : 'bad audio body' }); return; }
      next();
    });

  app.get('/api/servers/:id/sounds', ctx.requireAuth, requireMember, (req, res) => {
    const rows = db.prepare('SELECT * FROM sounds WHERE server_id=? ORDER BY created_at, id').all(req.params.id) as SoundRow[];
    res.json({ sounds: rows.map(toSound) });
  });

  app.post('/api/servers/:id/sounds', ctx.requireAuth, requireMember, readAudio, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const serverId = req.params.id;
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) { res.status(415).json({ error: 'expected an audio/* body' }); return; }

    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name || name.length > NAME_MAX) { res.status(400).json({ error: `name must be 1-${NAME_MAX} characters` }); return; }
    const emoji = typeof req.query.emoji === 'string' ? req.query.emoji : '';
    if (!emoji || emoji.length > EMOJI_MAX) { res.status(400).json({ error: 'emoji required' }); return; }
    // Declared by the client; the server cannot decode audio to measure it, so it is only range-checked.
    const durationMs = Number(req.query.durationMs);
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > LIMITS.SOUND_MAX_SECONDS * 1000) {
      res.status(400).json({ error: `durationMs must be 1-${LIMITS.SOUND_MAX_SECONDS * 1000}` }); return;
    }
    const mime = sniffAudio(body);
    if (!mime) { res.status(415).json({ error: 'unsupported audio format' }); return; }

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM sounds WHERE server_id=?').get(serverId) as { n: number };
    if (n >= SOUNDS_PER_SERVER) { res.status(409).json({ error: 'soundboard is full' }); return; }

    const id = newId();
    await fs.promises.writeFile(filePath(id), body, { mode: 0o600 });
    const createdAt = Date.now();
    db.prepare('INSERT INTO sounds (id, server_id, owner_id, name, emoji, mime, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, serverId, userId, name, emoji, mime, durationMs, createdAt);
    const sound = toSound(soundById(id)!);
    ctx.broadcastToServer(serverId, { t: 'sound.new', sound });
    res.json({ sound });
  });

  app.delete('/api/sounds/:id', ctx.requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const row = soundById(req.params.id);
    const role = row ? ctx.roleIn(row.server_id, userId) : null;
    if (!row || !role) { res.status(404).json({ error: 'sound not found' }); return; }
    if (row.owner_id !== userId && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }

    db.prepare('DELETE FROM sounds WHERE id=?').run(row.id);
    await fs.promises.rm(filePath(row.id), { force: true });
    ctx.broadcastToServer(row.server_id, { t: 'sound.delete', serverId: row.server_id, soundId: row.id });
    res.json({ ok: true });
  });

  app.get('/api/sounds/:id/file', ctx.requireAuth, async (req, res) => {
    const row = soundById(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'sound not found' }); return; }
    try {
      const data = await fs.promises.readFile(filePath(row.id));
      res.setHeader('Content-Type', row.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'sound file missing' });
    }
  });

  app.post('/api/channels/:id/sound-play', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = req.params.id;
    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    const channel = serverId ? ctx.getChannel(channelId) : null;
    if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }
    // Only someone actually in the voice channel can trigger a sound there.
    if (!isInVoiceChannel(channelId, userId)) { res.status(409).json({ error: 'join the voice channel first' }); return; }

    const soundId = (req.body as { soundId?: unknown } | undefined)?.soundId;
    const row = typeof soundId === 'string' ? soundById(soundId) : undefined;
    if (!row || row.server_id !== serverId) { res.status(404).json({ error: 'sound not found' }); return; }

    ctx.broadcastToServer(serverId!, { t: 'sound.play', serverId: serverId!, channelId, soundId: row.id, userId });
    res.json({ ok: true });
  });
}
