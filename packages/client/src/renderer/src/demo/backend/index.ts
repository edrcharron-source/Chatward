// Offline stand-in for the server. Implements docs/CONTRACT.md REST routes and the WS frame stream in memory.
import { DEFAULT_VOICE_BITRATE_KBPS, LIMITS, VOICE_BITRATES_KBPS, type Channel, type Member, type Message, type ServerFrame, type SoundboardSound, type User } from '@chatward/shared';
import { avatarPng } from './assets';
import { createWorld, makeMessage, newId, SERVER_ID, YOU_ID } from './world';

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
  return () => sockets.delete(send);
}

function later(ms: number, fn: () => void) {
  timers.push(setTimeout(fn, ms));
}

// ---------- bots ----------

const BOT_LINES = [
  'anyone seen the patch notes?', 'lol that is so true', 'brb getting snacks', 'gg that was close',
  'who wants to hop in the Lounge', 'this app feels snappy 👀', 'not gonna lie, that gif got me', 'ok I am back',
];
const BOT_REPLIES = ['lol', 'ha yes', 'agreed 😂', 'nice one', 'wait say that again', 'ok fair'];

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
      later(1500 + Math.random() * 1500, () => postBotMessage(channel, bot.user.id, pick(BOT_LINES)));
    }
    later(20_000 + Math.random() * 25_000, loop);
  };
  later(8_000, loop);
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
    later(40_000 + Math.random() * 30_000, loop);
  };
  later(45_000, loop);
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

/** Past members are not in the member list, but any user the demo knows about can be banned by id. */
function demoFormerUser(userId: string) {
  if (userId === YOU_ID) throw new HttpError(400, 'you cannot ban yourself');
  const bot = world.bots.find((b) => b.user.id === userId);
  if (!bot) throw new HttpError(404, 'user not found');
  return bot.user;
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

function botReplyToUser(channelId: string) {
  const bot = randomBot();
  if (!bot) return;
  later(1500 + Math.random() * 1500, () => {
    emit({ t: 'typing', channelId, userId: bot.user.id });
    later(1200 + Math.random() * 800, () => postBotMessage(channelId, bot.user.id, pick(BOT_REPLIES)));
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
// The offline demo has exactly one server, so creating another is refused rather than faked.
on('POST', /^\/api\/servers$/, () => json({ error: 'The offline demo has one server' }, 403));
on('POST', /^\/api\/servers\/([^/]+)\/channels$/, (r) => {
  serverGuard(r.match[1]);
  const body = (r.body ?? {}) as { name?: unknown; kind?: unknown };
  const kind = body.kind === 'voice' ? 'voice' : 'text';
  const channel: Channel = {
    id: newId(world, 'ch'), serverId: SERVER_ID, name: str(body.name, 'name', 48), kind,
    ...(kind === 'voice' ? { bitrateKbps: DEFAULT_VOICE_BITRATE_KBPS } : {}),
  };
  world.channels.push(channel);
  world.voice[channel.id] ??= [];
  emit({ t: 'channel.new', channel });
  return json({ channel }, 201);
});
on('PATCH', /^\/api\/servers\/([^/]+)\/channels\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  const channel = requireChannel(r.match[2]);
  const body = (r.body ?? {}) as { name?: unknown; bitrateKbps?: unknown };
  if (body.name === undefined && body.bitrateKbps === undefined) throw new HttpError(400, 'nothing to update');
  let updated: Channel = { ...channel, name: body.name === undefined ? channel.name : str(body.name, 'name', LIMITS.CHANNEL_NAME_MAX) };
  if (body.bitrateKbps !== undefined) {
    if (channel.kind !== 'voice') throw new HttpError(400, 'bitrate can only be set on voice channels');
    if (!(VOICE_BITRATES_KBPS as readonly unknown[]).includes(body.bitrateKbps)) {
      throw new HttpError(400, `bitrateKbps must be one of ${VOICE_BITRATES_KBPS.join(', ')}`);
    }
    updated = { ...updated, bitrateKbps: body.bitrateKbps as number };
  }
  world.channels = world.channels.map((c) => (c.id === channel.id ? updated : c));
  emit({ t: 'channel.update', channel: updated });
  return json({ channel: updated });
});
on('DELETE', /^\/api\/servers\/([^/]+)\/channels\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  const channel = requireChannel(r.match[2]);
  if (channel.kind === 'text' && world.channels.filter((c) => c.kind === 'text').length <= 1) {
    throw new HttpError(409, 'a server needs at least one text channel');
  }
  world.channels = world.channels.filter((c) => c.id !== channel.id);
  delete world.messages[channel.id];
  delete world.watch[channel.id];
  delete world.voice[channel.id];
  emit({ t: 'channel.delete', serverId: SERVER_ID, channelId: channel.id });
  return json({ ok: true });
});
on('PATCH', /^\/api\/servers\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  world.server = { ...world.server, name: str((r.body as { name?: unknown })?.name, 'server name', LIMITS.SERVER_NAME_MAX) };
  emit({ t: 'server.update', server: world.server });
  return json({ server: world.server });
});
// The demo keeps its one server so there is always something to look at. Deleting is turned off here.
on('DELETE', /^\/api\/servers\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  throw new HttpError(403, 'Deleting the server is turned off in the offline demo');
});
on('POST', /^\/api\/servers\/([^/]+)\/leave$/, (r) => {
  serverGuard(r.match[1]);
  throw new HttpError(400, 'the owner cannot leave; delete the server instead');
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
  demoTarget(YOU_ID, r.match[2]);
  removeDemoMember(r.match[2]);
  return json({ ok: true });
});
// Same as the server's transfer route: the old owner becomes an admin and the target becomes the owner.
on('POST', /^\/api\/servers\/([^/]+)\/transfer$/, (r) => {
  serverGuard(r.match[1]);
  const targetId = (r.body as { userId?: unknown })?.userId;
  if (typeof targetId !== 'string' || !targetId) throw new HttpError(400, 'userId is required');
  if (targetId === YOU_ID) throw new HttpError(400, 'you already own this server');
  memberOrThrow(targetId);
  world.members = world.members.map((m) => {
    if (m.user.id === YOU_ID) return { ...m, role: 'admin' };
    if (m.user.id === targetId) return { ...m, role: 'owner' };
    return m;
  });
  world.server = { ...world.server, ownerId: targetId };
  emit({ t: 'member.role', serverId: SERVER_ID, userId: YOU_ID, role: 'admin' });
  emit({ t: 'member.role', serverId: SERVER_ID, userId: targetId, role: 'owner' });
  return json({ ok: true });
});
on('POST', /^\/api\/servers\/([^/]+)\/invites$/, (r) => {
  serverGuard(r.match[1]);
  return json({ code: 'DEMO-INVITE', expiresAt: Date.now() + 7 * 24 * 3600_000 }, 201);
});
on('POST', /^\/api\/invites\/([^/]+)\/join$/, () => json({ server: world.server }));
on('GET', /^\/api\/servers\/([^/]+)\/invites$/, (r) => {
  serverGuard(r.match[1]);
  return json({ invites: [] });
});
on('DELETE', /^\/api\/servers\/([^/]+)\/invites\/([^/]+)$/, (r) => {
  serverGuard(r.match[1]);
  return json({ ok: true });
});
on('GET', /^\/api\/servers\/([^/]+)\/bans$/, (r) => {
  serverGuard(r.match[1]);
  return json({ bans: world.bans });
});
on('POST', /^\/api\/servers\/([^/]+)\/bans$/, (r) => {
  serverGuard(r.match[1]);
  const targetId = (r.body as { userId?: unknown })?.userId;
  if (typeof targetId !== 'string') throw new HttpError(400, 'userId is required');
  const user = world.members.some((m) => m.user.id === targetId) ? demoTarget(YOU_ID, targetId).user : demoFormerUser(targetId);
  world.bans = [...world.bans.filter((b) => b.user.id !== targetId), { user, bannedAt: Date.now() }];
  removeDemoMember(targetId);
  return json({ ok: true });
});
on('GET', /^\/api\/servers\/([^/]+)\/former-members$/, (r) => {
  serverGuard(r.match[1]);
  const current = new Set([...world.members.map((m) => m.user.id), ...world.bans.map((b) => b.user.id)]);
  const users = new Map<string, User>();
  for (const msgs of Object.values(world.messages)) {
    for (const msg of msgs) {
      const bot = world.bots.find((b) => b.user.id === msg.authorId);
      if (bot && !current.has(bot.user.id)) users.set(bot.user.id, bot.user);
    }
  }
  return json({ users: [...users.values()] });
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
  botReplyToUser(ch.id);
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
