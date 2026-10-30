// The demo's chatter bots, run on a real server. They are not accounts: no login, no devices, no role, no keys.
// Frames name a guest number and a line or clip number; the text and audio come from each app's own copy.
// Kept in memory only, so a restart clears them.
import type { Express } from 'express';
import {
  CHATTER_CLIP_MS,
  CHATTER_LINES,
  CHATTER_REPLIES,
  CHATTER_TIMING,
  chatterClip,
  chatterWait,
  GUEST_CHURNS,
  GUESTS_MAX,
  type GuestState,
} from '@chatward/shared';
import type { Ctx } from '../ctx.js';
import { perMember } from '../userLimit.js';
import { route, userIdOf, ApiError } from './servers.js';
import { isInVoiceChannel } from './voice.js';

interface Room {
  serverId: string;
  guests: number[];
  inVoice: Set<number>;
  timers: Set<ReturnType<typeof setTimeout>>;
  lastClip: number;
}

const rooms = new Map<string, Room>();
let seq = 0;
let ctxRef: Ctx | null = null;

function pick<T>(list: readonly T[]): T { return list[Math.floor(Math.random() * list.length)]; }

function later(room: Room, ms: number, fn: () => void): void {
  const t = setTimeout(() => {
    room.timers.delete(t);
    if (rooms.get(room.serverId) === room) fn();
  }, ms);
  room.timers.add(t);
}

function channelIds(ctx: Ctx, serverId: string, kind: 'text' | 'voice'): string[] {
  return (ctx.db.prepare('SELECT id FROM channels WHERE server_id=? AND kind=? ORDER BY rowid').all(serverId, kind) as { id: string }[])
    .map((r) => r.id);
}

function stateOf(ctx: Ctx, serverId: string): GuestState {
  const room = rooms.get(serverId);
  const voiceChannelId = channelIds(ctx, serverId, 'voice')[0] ?? null;
  return {
    serverId,
    guests: room ? [...room.guests] : [],
    voiceChannelId,
    inVoice: room && voiceChannelId ? room.guests.filter((g) => room.inVoice.has(g)) : [],
  };
}

function broadcastState(ctx: Ctx, serverId: string): GuestState {
  const state = stateOf(ctx, serverId);
  ctx.broadcastToServer(serverId, { t: 'guests.state', state });
  return state;
}

/** Typing, then a line, in the channel. */
function say(ctx: Ctx, serverId: string, room: Room, channelId: string, guest: number, reply: boolean, typingMs: number): void {
  ctx.broadcastToServer(serverId, { t: 'guests.typing', serverId, channelId, guest });
  later(room, typingMs, () => {
    if (!room.guests.includes(guest)) return;
    const line = Math.floor(Math.random() * (reply ? CHATTER_REPLIES.length : CHATTER_LINES.length));
    ctx.broadcastToServer(serverId, { t: 'guests.say', serverId, channelId, guest, id: `guest-msg-${++seq}`, createdAt: Date.now(), line, reply });
  });
}

function startLoops(ctx: Ctx, serverId: string, room: Room): void {
  // Text: a random guest says a random line in a random text channel now and then.
  const textLoop = () => {
    const channels = channelIds(ctx, serverId, 'text');
    if (room.guests.length && channels.length) {
      say(ctx, serverId, room, pick(channels), pick(room.guests), false, chatterWait(CHATTER_TIMING.lineTyping));
    }
    later(room, chatterWait(CHATTER_TIMING.nextLine), textLoop);
  };
  later(room, chatterWait(CHATTER_TIMING.firstLine), textLoop);

  // Voice: guests in the call take turns playing a clip. Nothing is sent while nobody is in the call to hear it.
  const voiceLoop = () => {
    const voiceChannelId = channelIds(ctx, serverId, 'voice')[0];
    const speakers = room.guests.filter((g) => room.inVoice.has(g));
    if (!voiceChannelId || !speakers.length || !someoneIn(ctx, serverId, voiceChannelId)) {
      later(room, chatterWait(CHATTER_TIMING.nextClip), voiceLoop);
      return;
    }
    const clip = chatterClip(CHATTER_CLIP_MS.length, room.lastClip);
    room.lastClip = clip;
    ctx.broadcastToServer(serverId, { t: 'guests.speak', serverId, channelId: voiceChannelId, guest: pick(speakers), clip });
    later(room, CHATTER_CLIP_MS[clip] + chatterWait(CHATTER_TIMING.nextClip), voiceLoop);
  };
  later(room, chatterWait(CHATTER_TIMING.firstClip), voiceLoop);

  // The churning guest drops in and out of the voice channel.
  const churnLoop = () => {
    if (room.guests.includes(GUEST_CHURNS)) {
      if (room.inVoice.has(GUEST_CHURNS)) room.inVoice.delete(GUEST_CHURNS);
      else room.inVoice.add(GUEST_CHURNS);
      broadcastState(ctx, serverId);
    }
    later(room, chatterWait(CHATTER_TIMING.nextChurn), churnLoop);
  };
  later(room, chatterWait(CHATTER_TIMING.firstChurn), churnLoop);
}

function someoneIn(ctx: Ctx, serverId: string, channelId: string): boolean {
  return ctx.getMembers(serverId).some((m) => isInVoiceChannel(channelId, m.user.id));
}

function closeRoom(serverId: string): void {
  const room = rooms.get(serverId);
  if (!room) return;
  room.timers.forEach(clearTimeout);
  rooms.delete(serverId);
}

/** A member posted in a text channel: one guest answers, as in the demo. */
export function guestsHearMessage(serverId: string, channelId: string): void {
  const room = rooms.get(serverId);
  const ctx = ctxRef;
  if (!room || !ctx || !room.guests.length) return;
  later(room, chatterWait(CHATTER_TIMING.replyPause), () => {
    if (!room.guests.length) return;
    say(ctx, serverId, room, channelId, pick(room.guests), true, chatterWait(CHATTER_TIMING.replyTyping));
  });
}

export function register(app: Express, ctx: Ctx): void {
  ctxRef = ctx;
  const memberOf = (serverId: string, userId: string) => {
    if (!ctx.roleIn(serverId, userId)) throw new ApiError(404, 'server not found');
  };

  app.get('/api/servers/:id/guests', ctx.requireAuth, route((req, res) => {
    memberOf(req.params.id, userIdOf(req));
    res.json(stateOf(ctx, req.params.id));
  }));

  app.post('/api/servers/:id/guests', ctx.requireAuth, perMember(60_000, 30), route((req, res) => {
    const serverId = req.params.id;
    memberOf(serverId, userIdOf(req));
    const room = rooms.get(serverId) ?? { serverId, guests: [], inVoice: new Set<number>(), timers: new Set(), lastClip: -1 };
    if (room.guests.length >= GUESTS_MAX) return void res.json(stateOf(ctx, serverId));
    if (!rooms.has(serverId)) {
      rooms.set(serverId, room);
      startLoops(ctx, serverId, room);
    }
    const guest = [...Array(GUESTS_MAX).keys()].find((g) => !room.guests.includes(g))!;
    room.guests.push(guest);
    if (guest !== GUEST_CHURNS) room.inVoice.add(guest);
    res.json(broadcastState(ctx, serverId));
  }));

  app.delete('/api/servers/:id/guests', ctx.requireAuth, perMember(60_000, 30), route((req, res) => {
    const serverId = req.params.id;
    memberOf(serverId, userIdOf(req));
    const room = rooms.get(serverId);
    if (room) {
      const gone = room.guests.pop()!;
      room.inVoice.delete(gone);
      if (!room.guests.length) closeRoom(serverId);
    }
    res.json(broadcastState(ctx, serverId));
  }));
}
