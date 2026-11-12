// Offline stand-in for the server. Implements docs/CONTRACT.md REST routes and the WS frame stream in memory.
import { CHATTER_LINES, CHATTER_REPLIES, CHATTER_TIMING, chatterNamed, chatterReply, chatterWait, DEFAULT_VOICE_BITRATE_KBPS, LIMITS, VOICE_BITRATES_KBPS, type Channel, type Member, type Message, type LibraryGif, type ServerFrame, type SoundboardSound, type User } from '@chatward/shared';
import { avatarPng } from './assets';
import { createWorld, makeMessage, newId, SERVER_ID, YOU_ID } from './world';
import { demoDecode } from '../codec';

export const DEMO_TOKEN = 'demo-token';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let world = createWorld();
const sockets = new Set<(f: ServerFrame) => void>();
let timers: ReturnType<typeof setTimeout>[] = [];

export function demoUser(): User { return world.you; }

/** Fresh world and bot activity. Called on every entry into demo mode. */
export function startDemoWorld(): void {
  stopDemoWorld();
  world = createWorld();
  scheduleBotChatter();
  scheduleVoiceChurn();
}

export function stopDemoWorld(): void {
  timers.forEach(clearTimeout);
  timers = [];
}

function emit(frame: ServerFrame) { sockets.forEach((send) => send(frame)); }

/** Used by the WebSocket shim. Returns a detach function. */
export function attachSocket(send: (f: ServerFrame) => void): () => void {
  sockets.add(send);
  send({ t: 'ready', user: world.you, presence: {} });
  for (const b of world.bots) send({ t: 'presence', userId: b.user.id, status: 'online' });
  // One friend is listening to something, to show the Spotify "listening to" line.
  const listener = world.bots[0];
  if (listener) send({ t: 'activity', userId: listener.user.id, activity: { kind: 'spotify', title: 'Clair de Lune', artist: 'Claude Debussy', durationMs: 303_000, progressMs: 41_000 } });
  // A second friend listens along with the first, so the Listen Along card has someone in it.
  const along = world.bots[1];
  if (listener && along) send({ t: 'activity', userId: along.user.id, activity: { kind: 'spotify', title: 'Clair de Lune', artist: 'Claude Debussy', alongWith: listener.user.id } });
  return () => sockets.delete(send);
}

function later(ms: number, fn: () => void) {
  timers.push(setTimeout(fn, ms));
}

// ---------- bots ----------


function randomBot() {
  const bots = activeBots();
  return bots[Math.floor(Math.random() * bots.length)];
}

function pick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)]; }

function scheduleBotChatter() {
  const loop = () => {
    const bot = randomBot();
    if (bot) {
      const channel = pick(['demo-ch-general', 'demo-ch-memes']);
      emit({ t: 'typing', channelId: channel, userId: bot.user.id });
      later(chatterWait(CHATTER_TIMING.lineTyping), () => postBotMessage(channel, bot.user.id, pick(CHATTER_LINES)));
    }
    later(chatterWait(CHATTER_TIMING.nextLine), loop);
  };
  later(chatterWait(CHATTER_TIMING.firstLine), loop);
}

function scheduleVoiceChurn() {
  // Casey drops into the Lounge now and then, so join/leave tones and the member list both move.
  const loop = () => {
    if (isMember('demo-casey')) {
      const lounge = (world.voice['demo-vc-lounge'] ??= []);
      const inLounge = lounge.includes('demo-casey');
      world.voice['demo-vc-lounge'] = inLounge ? lounge.filter((id) => id !== 'demo-casey') : [...lounge, 'demo-casey'];
      emit({ t: 'voice.state', serverId: SERVER_ID, channelId: 'demo-vc-lounge', userIds: world.voice['demo-vc-lounge'] });
    }
    later(chatterWait(CHATTER_TIMING.nextChurn), loop);
  };
  later(chatterWait(CHATTER_TIMING.firstChurn), loop);
}

function isMember(userId: string): boolean {
  return world.members.some((m) => m.user.id === userId);
}

/** Bots that are still in the server. A kicked or banned bot stops talking. */
function activeBots() {
  return world.bots.filter((b) => isMember(b.user.id));
}

function memberOrThrow(userId: string): Member {
  const member = world.members.find((m) => m.user.id === userId);
  if (!member) throw new HttpError(404, 'member not found');
  return member;
}

/**
 * Same rules as the server's moderation checks. The demo has one person and that person owns the server,
 * so the only cases that can refuse are self-targeting, owner targeting and unknown members.
 */
function demoTarget(actorId: string, targetId: string): Member {
  if (targetId === actorId) throw new HttpError(400, 'you cannot remove yourself');
  const target = memberOrThrow(targetId);
  if (target.role === 'owner') throw new HttpError(403, 'you cannot remove this member');
  return target;
}

/** Takes a member out of the server, their voice call, and the member list, then tells every open socket. */
function removeDemoMember(userId: string) {
  world.members = world.members.filter((m) => m.user.id !== userId);
  for (const [channelId, userIds] of Object.entries(world.voice)) {
    if (!userIds.includes(userId)) continue;
    world.voice[channelId] = userIds.filter((id) => id !== userId);
    emit({ t: 'voice.state', serverId: SERVER_ID, channelId, userIds: world.voice[channelId] });
  }
  emit({ t: 'member.leave', serverId: SERVER_ID, userId });
}

function postBotMessage(channelId: string, authorId: string, text: string) {
  const message = makeMessage(world, channelId, authorId, { text });
  world.messages[channelId].push(message);
  emit({ t: 'message.new', message });
}

const recentReplies: number[] = [];

/** A bot answers what you wrote with a fitting reply, and sometimes a second bot chimes in. A bot called by name answers. */
function botReplyToUser(channelId: string, text: string) {
  const bots = activeBots();
  const bot = bots[chatterNamed(text, bots.map((b) => b.user.displayName))] ?? randomBot();
  if (!bot) return;
  const pickReply = () => {
    const r = chatterReply(text, recentReplies);
    recentReplies.push(r.line);
    if (recentReplies.length > 12) recentReplies.shift();
    return r;
  };
  const first = pickReply();
  const second = first.matched && bots.length > 1 && Math.random() < 0.3 ? pickReply() : null;
  const other = pick(bots.filter((b) => b !== bot));
  later(chatterWait(CHATTER_TIMING.replyPause), () => {
    emit({ t: 'typing', channelId, userId: bot.user.id });
    later(chatterWait(CHATTER_TIMING.replyTyping), () => {
      postBotMessage(channelId, bot.user.id, CHATTER_REPLIES[first.line]);
      if (!second || !other) return;
      later(chatterWait(CHATTER_TIMING.replyPause), () => {
        emit({ t: 'typing', channelId, userId: other.user.id });
        later(chatterWait(CHATTER_TIMING.replyTyping), () => postBotMessage(channelId, other.user.id, CHATTER_REPLIES[second.line]));
      });
    });
  });
}

// ---------- routing ----------

interface Req {
  method: string;
  url: URL;
  body: unknown;
  bytes: Uint8Array | null;
  type: string;
  match: RegExpMatchArray;
}

type Handler = (r: Req) => Response | Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: RegExp, handler: Handler) => routes.push([method, pattern, handler]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function bytesResponse(bytes: Uint8Array, mime: string): Response {
  return new Response(bytes as BodyInit, { status: 200, headers: { 'Content-Type': mime } });
}

function requireChannel(id: string): Channel {
  const ch = world.channels.find((c) => c.id === id);
  if (!ch) throw new HttpError(404, 'channel not found');
  return ch;
}

function bundle() {
  return { server: world.server, channels: world.channels, members: world.members };
}

function serverGuard(id: string) {
  if (id !== SERVER_ID) throw new HttpError(404, 'server not found');
}

/** Mirrors the server's profile text rules, so demo and real mode reject the same input. */
function demoText(v: unknown, max: number, multiline: boolean): string {
  if (typeof v !== 'string') throw new HttpError(400, 'invalid text');
  const s = v.trim();
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (s.length > max || control.test(s)) throw new HttpError(400, 'invalid text');
  return s;
}

function demoColor(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, 'invalid color');
  return v.toLowerCase();
}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new HttpError(400, `invalid ${field}`);
  return v.trim();
}

on('POST', /^\/api\/auth\/(login|register)$/, () => json({ token: DEMO_TOKEN, user: world.you }));
on('GET', /^\/api\/me$/, () => json({ user: world.you }));
// Demo mode has no real devices to list.
on('GET', /^\/api\/me\/devices$/, () => json({ devices: [] }));

// The demo has no passwords, so these accept any password or code. They keep the server's shape rules and its
// refusals that do not depend on a real password, so the same mistakes show the same messages in both modes.
const RESET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RESET_CODE_MS = 24 * 60 * 60_000;

function demoNewPassword(v: unknown, current: unknown): void {
  if (typeof v !== 'string' || v.length < LIMITS.PASSWORD_MIN) throw new HttpError(400, `password must be at least ${LIMITS.PASSWORD_MIN} characters`);
  if (v === current) throw new HttpError(400, 'the new password must be different from the current one');
}

on('POST', /^\/api\/me\/password$/, (r) => {
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (typeof body.currentPassword !== 'string' || body.currentPassword === '') throw new HttpError(403, 'current password is wrong');
  demoNewPassword(body.newPassword, body.currentPassword);
  return json({ token: DEMO_TOKEN, user: world.you });
});
on('POST', /^\/api\/me\/delete$/, (r) => {
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (typeof body.password !== 'string' || body.password === '') throw new HttpError(403, 'password is incorrect');
  // Same rule as the server: an owner must hand off or delete their servers first.
  if (world.server.ownerId === YOU_ID) throw new HttpError(409, 'the owner account cannot be deleted');
  // Nothing is really deleted here. The caller signs out, and the next entry into demo mode starts a fresh world.
  return json({ ok: true });
});
on('POST', /^\/api\/auth\/reset$/, (r) => {
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (typeof body.code !== 'string' || body.code.trim() === '') throw new HttpError(403, 'reset code is invalid or expired');
  demoNewPassword(body.newPassword, undefined);
  return json({ token: DEMO_TOKEN, user: world.you });
});
on('POST', /^\/api\/servers\/([^/]+)\/members\/([^/]+)\/reset-code$/, (r) => {
  serverGuard(r.match[1]);
  if (world.server.ownerId !== YOU_ID) throw new HttpError(403, 'only the owner can issue reset codes');
  if (r.match[2] === YOU_ID) throw new HttpError(400, 'use Change password to change your own password');
  if (!world.members.some((m) => m.user.id === r.match[2])) throw new HttpError(404, 'member not found');
  const chars = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => RESET_CODE_ALPHABET[b % 32]).join('');
  const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  return json({ code, expiresAt: Date.now() + RESET_CODE_MS });
});
on('PATCH', /^\/api\/me$/, (r) => {
  const body = (r.body ?? {}) as Record<string, unknown>;
  const name = body.displayName === undefined ? world.you.displayName : str(body.displayName, 'displayName', 48);
  const p = world.you.profile;
  const profile = {
    ...p,
    bio: body.bio === undefined ? p.bio : demoText(body.bio, 190, true),
    pronouns: body.pronouns === undefined ? p.pronouns : demoText(body.pronouns, 40, false),
    accentColor: body.accentColor === undefined ? p.accentColor : demoColor(body.accentColor),
    bannerColor: body.bannerColor === undefined ? p.bannerColor : demoColor(body.bannerColor),
  };
  world.you = { ...world.you, displayName: name, profile };
  world.members = world.members.map((m) => (m.user.id === YOU_ID ? { ...m, user: world.you } : m));
  emit({ t: 'user.update', user: world.you });
  return json({ user: world.you });
});
on('PUT', /^\/api\/me\/banner$/, (r) => {
  if (!r.bytes) throw new HttpError(400, 'missing image');
  world.blobs.set(`banner:${YOU_ID}`, { bytes: r.bytes, mime: r.type });
  world.you = { ...world.you, profile: { ...world.you.profile, bannerUrl: `/api/banners/${YOU_ID}` } };
  world.members = world.members.map((m) => (m.user.id === YOU_ID ? { ...m, user: world.you } : m));
  emit({ t: 'user.update', user: world.you });
  return json({ user: world.you });
});
on('DELETE', /^\/api\/me\/banner$/, () => {
  world.blobs.delete(`banner:${YOU_ID}`);
  world.you = { ...world.you, profile: { ...world.you.profile, bannerUrl: null } };
  world.members = world.members.map((m) => (m.user.id === YOU_ID ? { ...m, user: world.you } : m));
  emit({ t: 'user.update', user: world.you });
  return json({ user: world.you });
});
on('GET', /^\/api\/banners\/([^/]+)$/, (r) => {
  const banner = world.blobs.get(`banner:${r.match[1]}`);
  if (!banner) throw new HttpError(404, 'no banner');
  return bytesResponse(banner.bytes, banner.mime);
});
on('PUT', /^\/api\/me\/avatar$/, (r) => {
  if (!r.bytes) throw new HttpError(400, 'missing image');
  world.blobs.set(`avatar:${YOU_ID}`, { bytes: r.bytes, mime: r.type });
  world.you = { ...world.you, avatarUrl: `/api/avatars/${YOU_ID}` };
  emit({ t: 'user.update', user: world.you });
  return json({ user: world.you });
});
on('DELETE', /^\/api\/me\/avatar$/, () => {
  world.blobs.delete(`avatar:${YOU_ID}`);
  world.you = { ...world.you, avatarUrl: null };
  emit({ t: 'user.update', user: world.you });
  return json({ user: world.you });
});
on('GET', /^\/api\/avatars\/([^/]+)$/, async (r) => {
  const id = r.match[1];
  const custom = world.blobs.get(`avatar:${id}`);
  if (custom) return bytesResponse(custom.bytes, custom.mime);
  const bot = world.bots.find((b) => b.user.id === id);
  const hue = id === YOU_ID ? 260 : bot?.hue ?? 0;
  const name = id === YOU_ID ? 'Y' : bot?.user.displayName ?? '?';
  return bytesResponse(await avatarPng(name, hue), 'image/png');
});

on('GET', /^\/api\/servers$/, () => json({ servers: [bundle()] }));
on('PATCH', /^\/api\/servers\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  world.server = { ...world.server, name: str((r.body as { name?: unknown })?.name, 'server name', LIMITS.SERVER_NAME_MAX) };
  emit({ t: 'server.update', server: world.server });
  return json({ server: world.server });
});
on('PATCH', /^\/api\/servers\/([^/]+)\/members\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  const role = (r.body as { role?: unknown })?.role;
  if (role !== 'admin' && role !== 'member') throw new HttpError(400, 'role must be admin or member');
  const target = memberOrThrow(r.match[2]);
  if (target.role === 'owner') throw new HttpError(400, 'the owner role cannot be changed');
  world.members = world.members.map((m) => (m === target ? { ...m, role } : m));
  emit({ t: 'member.role', serverId: SERVER_ID, userId: target.user.id, role });
  return json({ ok: true });
});
on('DELETE', /^\/api\/servers\/([^/]+)\/members\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  // As on the real server, removing someone turns their account off, so they show under Removed accounts.
  const { user } = demoTarget(YOU_ID, r.match[2]);
  world.bans = [...world.bans.filter((b) => b.user.id !== user.id), { user, bannedAt: Date.now() }];
  removeDemoMember(r.match[2]);
  return json({ ok: true });
});
on('GET', /^\/api\/servers\/([^/]+)\/bans$/, (r) => {
  serverGuard(r.match[1]);
  return json({ bans: world.bans });
});
on('DELETE', /^\/api\/servers\/([^/]+)\/bans\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  const before = world.bans.length;
  world.bans = world.bans.filter((b) => b.user.id !== r.match[2]);
  if (world.bans.length === before) throw new HttpError(404, 'ban not found');
  return json({ ok: true });
});
on('GET', /^\/api\/servers\/([^/]+)\/voice-state$/, (r) => {
  serverGuard(r.match[1]);
  return json({ channels: world.voice });
});

on('GET', /^\/api\/channels\/([^/]+)\/messages$/, (r) => {
  const ch = requireChannel(r.match[1]);
  const list = world.messages[ch.id] ?? [];
  const before = r.url.searchParams.get('before');
  const after = r.url.searchParams.get('after');
  const limit = Math.min(50, Number(r.url.searchParams.get('limit')) || 50);
  if (after) {
    // Demo ids are "m-<n>" and count up, so compare the number: the cursor may already be deleted.
    const num = (id: string) => Number(id.split('-').pop());
    return json({ messages: list.filter((m) => num(m.id) > num(after)).slice(0, limit) });
  }
  const end = before ? list.findIndex((m) => m.id === before) : list.length;
  return json({ messages: list.slice(Math.max(0, end - limit), Math.max(0, end)) });
});
on('POST', /^\/api\/channels\/([^/]+)\/messages$/, (r) => {
  const ch = requireChannel(r.match[1]);
  const body = (r.body ?? {}) as { ciphertext?: unknown; keyVersion?: unknown };
  if (typeof body.ciphertext !== 'string' || !body.ciphertext) throw new HttpError(400, 'invalid ciphertext');
  const message: Message = {
    id: newId(world, 'm'), channelId: ch.id, authorId: YOU_ID, createdAt: Date.now(), editedAt: null,
    keyVersion: Number(body.keyVersion) || 1, ciphertext: body.ciphertext,
  };
  (world.messages[ch.id] ??= []).push(message);
  emit({ t: 'message.new', message });
  botReplyToUser(ch.id, demoDecode(body.ciphertext)?.text ?? '');
  return json({ message }, 201);
});
on('PATCH', /^\/api\/messages\/([^/]+)$/, (r) => {
  const list = Object.values(world.messages).find((l) => l.some((m) => m.id === r.match[1]));
  const existing = list?.find((m) => m.id === r.match[1]);
  if (!list || !existing || existing.authorId !== YOU_ID) throw new HttpError(404, 'message not found');
  const body = (r.body ?? {}) as { ciphertext?: unknown; keyVersion?: unknown };
  const updated: Message = { ...existing, ciphertext: str(body.ciphertext, 'ciphertext', 16_000), keyVersion: Number(body.keyVersion) || 1, editedAt: Date.now() };
  list[list.indexOf(existing)] = updated;
  emit({ t: 'message.edit', message: updated });
  return json({ message: updated });
});
on('DELETE', /^\/api\/messages\/([^/]+)$/, (r) => {
  const entry = Object.entries(world.messages).find(([, l]) => l.some((m) => m.id === r.match[1]));
  const existing = entry?.[1].find((m) => m.id === r.match[1]);
  if (!entry || !existing || existing.authorId !== YOU_ID) throw new HttpError(404, 'message not found');
  world.messages[entry[0]] = entry[1].filter((m) => m !== existing);
  emit({ t: 'message.delete', channelId: entry[0], messageId: existing.id });
  return json({ ok: true });
});

// Key envelopes are not needed offline: demo messages are plain, see demo/codec.ts.
on('POST', /^\/api\/channels\/([^/]+)\/keys$/, () => json({ ok: true }));
on('GET', /^\/api\/channels\/([^/]+)\/keys$/, () => json({ envelopes: [] }));
on('GET', /^\/api\/channels\/([^/]+)\/key-status$/, () => json({ latestVersion: 1, devicesMissing: [] }));

on('GET', /^\/api\/channels\/([^/]+)\/watch$/, (r) => json({ state: world.watch[requireChannel(r.match[1]).id] ?? null, serverNow: Date.now() }));
on('POST', /^\/api\/channels\/([^/]+)\/watch$/, (r) => {
  const ch = requireChannel(r.match[1]);
  const body = (r.body ?? {}) as { ciphertext?: unknown; keyVersion?: unknown };
  const snapshot = { ciphertext: str(body.ciphertext, 'ciphertext', 16_000), keyVersion: Number(body.keyVersion) || 1, authorId: YOU_ID, ts: Date.now() };
  world.watch[ch.id] = snapshot;
  emit({ t: 'watch.sync', channelId: ch.id, ...snapshot });
  return json({ ok: true, ts: snapshot.ts });
});

on('POST', /^\/api\/uploads$/, (r) => {
  if (!r.bytes) throw new HttpError(400, 'missing body');
  const uploadId = newId(world, 'up');
  world.blobs.set(uploadId, { bytes: r.bytes, mime: r.type });
  return json({ uploadId }, 201);
});
on('GET', /^\/api\/uploads\/([^/]+)$/, (r) => {
  const blob = world.blobs.get(r.match[1]);
  if (!blob) throw new HttpError(404, 'upload not found');
  return bytesResponse(blob.bytes, blob.mime);
});

on('GET', /^\/api\/servers\/([^/]+)\/sounds$/, (r) => {
  serverGuard(r.match[1]);
  return json({ sounds: world.sounds });
});
on('POST', /^\/api\/servers\/([^/]+)\/sounds$/, (r) => {
  serverGuard(r.match[1]);
  if (!r.bytes || !r.type.startsWith('audio/')) throw new HttpError(400, 'expected audio bytes');
  const id = newId(world, 'snd');
  const sound: SoundboardSound = {
    id, serverId: SERVER_ID, ownerId: YOU_ID,
    name: str(r.url.searchParams.get('name'), 'name', 32),
    emoji: r.url.searchParams.get('emoji') || '🔊',
    url: `/api/sounds/${id}/file`,
    durationMs: Number(r.url.searchParams.get('durationMs')) || 0,
  };
  world.blobs.set(id, { bytes: r.bytes, mime: r.type });
  world.sounds.push(sound);
  emit({ t: 'sound.new', sound });
  return json({ sound }, 201);
});
on('DELETE', /^\/api\/sounds\/([^/]+)$/, (r) => {
  const sound = world.sounds.find((s) => s.id === r.match[1]);
  if (!sound) throw new HttpError(404, 'sound not found');
  world.sounds = world.sounds.filter((s) => s !== sound);
  world.blobs.delete(sound.id);
  emit({ t: 'sound.delete', serverId: SERVER_ID, soundId: sound.id });
  return json({ ok: true });
});
on('GET', /^\/api\/sounds\/([^/]+)\/file$/, (r) => {
  const blob = world.blobs.get(r.match[1]);
  if (!blob) throw new HttpError(404, 'sound not found');
  return bytesResponse(blob.bytes, blob.mime);
});
on('POST', /^\/api\/channels\/([^/]+)\/sound-play$/, (r) => {
  const ch = requireChannel(r.match[1]);
  const soundId = str((r.body as { soundId?: unknown })?.soundId, 'soundId', 64);
  emit({ t: 'sound.play', serverId: SERVER_ID, channelId: ch.id, soundId, userId: YOU_ID });
  return json({ ok: true });
});

// The server's GIF library. Same rules as the real server, kept in memory.
function demoGifDetails(name: unknown, tags: unknown): { name: string; tags: string[] } {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n || n.length > LIMITS.LIBRARY_GIF_NAME_MAX) throw new HttpError(400, `Give the GIF a name (up to ${LIMITS.LIBRARY_GIF_NAME_MAX} characters).`);
  const list = (Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length > LIMITS.LIBRARY_GIF_TAGS_MAX || unique.some((t) => t.length > LIMITS.LIBRARY_GIF_TAG_MAX)) {
    throw new HttpError(400, `Up to ${LIMITS.LIBRARY_GIF_TAGS_MAX} tags, each up to ${LIMITS.LIBRARY_GIF_TAG_MAX} characters.`);
  }
  return { name: n, tags: unique };
}
function demoGif(id: string): LibraryGif {
  const gif = world.gifs.find((g) => g.id === id);
  if (!gif) throw new HttpError(404, 'GIF not found');
  return gif;
}
on('GET', /^\/api\/servers\/([^/]+)\/library-gifs$/, (r) => {
  serverGuard(r.match[1]);
  return json({ gifs: world.gifs });
});
on('POST', /^\/api\/servers\/([^/]+)\/library-gifs$/, (r) => {
  serverGuard(r.match[1]);
  const { name, tags } = demoGifDetails(r.url.searchParams.get('name'), r.url.searchParams.get('tags'));
  const b = r.bytes;
  const sig = b && b.length >= 13 ? String.fromCharCode(...b.subarray(0, 6)) : '';
  if (!b || (sig !== 'GIF87a' && sig !== 'GIF89a')) throw new HttpError(400, "That file isn't a GIF.");
  if (b.length > LIMITS.LIBRARY_GIF_MAX_BYTES) throw new HttpError(413, `GIFs must be ${LIMITS.LIBRARY_GIF_MAX_BYTES / (1024 * 1024)} MB or smaller.`);
  const id = newId(world, 'gif');
  const gif: LibraryGif = {
    id, serverId: SERVER_ID, ownerId: YOU_ID, name, tags,
    width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), size: b.length, uses: 0, createdAt: Date.now(),
  };
  world.blobs.set(id, { bytes: b, mime: 'image/gif' });
  world.gifs.unshift(gif);
  emit({ t: 'gif.new', gif });
  return json({ gif }, 201);
});
on('POST', /^\/api\/servers\/([^/]+)\/library-gifs\/from-url$/, () => {
  throw new HttpError(400, "The offline demo can't download KLIPY GIFs. Upload a .gif file instead.");
});
on('PATCH', /^\/api\/library-gifs\/([^/]+)$/, (r) => {
  const gif = demoGif(r.match[1]);
  const body = (r.body ?? {}) as { name?: unknown; tags?: unknown };
  const details = demoGifDetails(body.name ?? gif.name, body.tags ?? gif.tags);
  const updated = { ...gif, ...details };
  world.gifs = world.gifs.map((g) => (g.id === gif.id ? updated : g));
  emit({ t: 'gif.update', gif: updated });
  return json({ gif: updated });
});
on('DELETE', /^\/api\/library-gifs\/([^/]+)$/, (r) => {
  const gif = demoGif(r.match[1]);
  world.gifs = world.gifs.filter((g) => g !== gif);
  world.blobs.delete(gif.id);
  emit({ t: 'gif.delete', serverId: SERVER_ID, gifId: gif.id });
  return json({ ok: true });
});
on('POST', /^\/api\/library-gifs\/([^/]+)\/use$/, (r) => {
  const gif = demoGif(r.match[1]);
  world.gifs = world.gifs.map((g) => (g === gif ? { ...g, uses: g.uses + 1 } : g));
  return json({ ok: true });
});
on('GET', /^\/api\/library-gifs\/([^/]+)\/file$/, (r) => {
  const blob = world.blobs.get(demoGif(r.match[1]).id);
  if (!blob) throw new HttpError(404, 'GIF not found');
  return bytesResponse(blob.bytes, blob.mime);
});

on('GET', /^\/api\/gifs\/(search|trending)$/, async (r) => {
  const kind = r.match[1] as 'search' | 'trending';
  const q = (r.url.searchParams.get('q') ?? '').trim();
  if (q.length > 100) throw new HttpError(400, 'q must be at most 100 characters');
  if (kind === 'search' && !q) return json({ results: [] });
  // Real KLIPY results through the main process. With no key saved, say so in the tab instead of showing fake GIFs.
  const live = await window.chatward.demo.gifs(kind, q, r.url.searchParams.get('pos') ?? undefined);
  if (live) return json(live.body, live.status);
  return json({ results: [], disabled: true, hint: 'Paste a KLIPY key in Settings → Privacy → Demo internet to load real GIFs.' });
});

// Real link previews, fetched by the main process with the same SSRF guards as the server.
on('GET', /^\/api\/linkpreview$/, async (r) => {
  const live = await window.chatward.demo.linkPreview(r.url.searchParams.get('url') ?? '');
  return json(live.body, live.status);
});

on('POST', /^\/api\/voice\/leave$/, () => json({ ok: true }));
on('POST', /^\/api\/voice\/token$/, () => json({ error: 'Voice calls are not in the offline demo yet' }, 503));

/** Entry point for the fetch shim. Never touches the network. */
export async function demoFetch(url: URL, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const type = headers.get('Content-Type') ?? '';
  const { body, bytes } = await readBody(init.body);
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    try {
      return await handler({ method, url, body, bytes, type, match });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      return json({ error: err instanceof Error ? err.message : 'demo error' }, 500);
    }
  }
  return json({ error: `Not in the offline demo: ${method} ${url.pathname}` }, 404);
}

async function readBody(b: BodyInit | null | undefined): Promise<{ body: unknown; bytes: Uint8Array | null }> {
  if (b == null) return { body: undefined, bytes: null };
  if (typeof b === 'string') return { body: JSON.parse(b), bytes: null };
  if (b instanceof Blob) return { body: undefined, bytes: new Uint8Array(await b.arrayBuffer()) };
  if (b instanceof ArrayBuffer) return { body: undefined, bytes: new Uint8Array(b) };
  if (ArrayBuffer.isView(b)) return { body: undefined, bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
  return { body: undefined, bytes: null };
}
