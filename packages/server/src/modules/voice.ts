import type { Express } from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { Ctx, AuthedRequest } from '../ctx.js';

// In-memory voice occupancy. Lost on restart, which is fine: clients rejoin.
const occupants = new Map<string, Set<string>>(); // channelId -> userIds
const voiceChannelOf = new Map<string, string>(); // userId -> channelId (a user is in at most one VC)
const selfState = new Map<string, { muted: boolean; deafened: boolean }>(); // userId -> self mute/deafen, reported by the client

// Only needed to join. An active call keeps its LiveKit session, so a short TTL does not cut calls off.
const TOKEN_TTL = '10m';

// A dropped websocket does not end a call: LiveKit keeps the media flowing. Hold the voice slot this long so a
// quick reconnect keeps it. Kicks and explicit leaves ignore this and still act at once.
const VOICE_GRACE_MS = 30_000;
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // userId -> pending slot removal

/** True if the user currently holds a voice slot in this channel. Used by soundboard. */
export function isInVoiceChannel(channelId: string, userId: string): boolean {
  return occupants.get(channelId)?.has(userId) ?? false;
}

/** True if the user has muted or deafened themselves in their current call. Used by soundboard. */
export function isVoiceSilenced(userId: string): boolean {
  const state = selfState.get(userId);
  return !!state && (state.muted || state.deafened);
}

/** Removes the user from whatever voice channel they are in. For kicks, explicit leaves and the grace timer. */
export function leaveVoice(ctx: Ctx, userId: string): void {
  cancelGrace(userId);
  const channelId = voiceChannelOf.get(userId);
  if (channelId) leaveChannel(ctx, channelId, userId);
}

function cancelGrace(userId: string): void {
  const timer = graceTimers.get(userId);
  if (!timer) return;
  clearTimeout(timer);
  graceTimers.delete(userId);
}

/**
 * For a server kick: drops the user from voice, then removes them from every voice room on the server, so they stop
 * receiving media now. Not used on a dropped socket, where a reconnect should keep the call. Checks every room
 * rather than the in-memory occupancy, which a dropped socket may have cleared.
 */
export function kickFromCall(ctx: Ctx, serverId: string, userId: string): void {
  leaveVoice(ctx, userId);
  const rooms = new RoomServiceClient(ctx.config.livekit.apiUrl, ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret);
  const channels = ctx.db.prepare("SELECT id FROM channels WHERE server_id=? AND kind='voice'").all(serverId) as { id: string }[];
  for (const { id } of channels) {
    // Fails for rooms the user is not in, which is expected. A real failure is logged.
    rooms.removeParticipant(id, userId).catch((err: unknown) => console.warn('livekit removeParticipant failed', id, err));
  }
}

/** Drops the user from the channel's voice slot and from the LiveKit room, so they stop hearing the call now. */
function kickFromChannelCall(ctx: Ctx, channelId: string, userId: string): void {
  leaveChannel(ctx, channelId, userId);
  removeFromRoom(ctx, channelId, userId);
}

/** Ends the user's LiveKit session in a room. Fails if LiveKit no longer has them (already left or still connecting). */
function removeFromRoom(ctx: Ctx, channelId: string, userId: string): void {
  const rooms = new RoomServiceClient(ctx.config.livekit.apiUrl, ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret);
  rooms.removeParticipant(channelId, userId).catch((err: unknown) => console.warn('livekit removeParticipant failed', err));
}

/** Puts the user in the channel's voice slot, leaving any other voice channel they hold. */
function occupy(ctx: Ctx, channelId: string, userId: string): void {
  const previous = voiceChannelOf.get(userId);
  if (previous && previous !== channelId) leaveChannel(ctx, previous, userId);

  let set = occupants.get(channelId);
  if (!set) occupants.set(channelId, (set = new Set()));
  if (!set.has(userId)) {
    set.add(userId);
    voiceChannelOf.set(userId, channelId);
    broadcastState(ctx, channelId);
  }
}

/** Empties a voice channel, e.g. when the channel is deleted. */
export function clearVoiceChannel(ctx: Ctx, channelId: string): void {
  for (const userId of [...(occupants.get(channelId) ?? [])]) leaveChannel(ctx, channelId, userId);
}

function leaveChannel(ctx: Ctx, channelId: string, userId: string): boolean {
  const set = occupants.get(channelId);
  if (!set?.has(userId)) return false;
  set.delete(userId);
  if (set.size === 0) occupants.delete(channelId);
  voiceChannelOf.delete(userId);
  selfState.delete(userId);
  broadcastState(ctx, channelId);
  return true;
}

function broadcastState(ctx: Ctx, channelId: string): void {
  const channel = ctx.getChannel(channelId);
  if (!channel) return;
  const userIds = [...(occupants.get(channelId) ?? [])];
  ctx.broadcastToServer(channel.serverId, { t: 'voice.state', serverId: channel.serverId, channelId, userIds });
}

export function register(app: Express, ctx: Ctx): void {
  // Last socket closed: keep the voice slot for the grace period. If they reconnect in time, onConnect cancels this.
  ctx.onDisconnect.push((userId) => {
    if (!voiceChannelOf.has(userId)) return;
    cancelGrace(userId);
    graceTimers.set(userId, setTimeout(() => {
      graceTimers.delete(userId);
      leaveVoice(ctx, userId);
    }, VOICE_GRACE_MS));
  });
  ctx.onConnect.push(cancelGrace);

  app.post('/api/voice/token', ctx.requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }

    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    const channel = serverId ? ctx.getChannel(channelId) : null;
    if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }

    // Every device of an account uses the same LiveKit identity, and LiveKit drops the older session when a second one
    // joins the same room. So a second device is refused while the first is still in the call. Our own device always
    // sends /voice/leave before joining again, so this only blocks another device.
    if (voiceChannelOf.get(userId) === channelId) {
      res.status(409).json({ error: 'You are already in this call on another device. Leave the call there first.' });
      return;
    }

    // Joining a channel implicitly leaves any other voice channel. The account may still hold that channel on another
    // device. LiveKit keeps that device's session in the old room, so end it there and tell the account's sockets, so
    // the other device hangs up instead of staying silently in the call.
    const previous = voiceChannelOf.get(userId);
    if (previous && previous !== channelId) {
      removeFromRoom(ctx, previous, userId);
      ctx.sendToUser(userId, { t: 'voice.moved', channelId: previous });
    }
    occupy(ctx, channelId, userId);

    const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, {
      identity: userId,
      name: ctx.getUser(userId)?.displayName,
      ttl: TOKEN_TTL,
    });
    at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });
    res.json({ url: ctx.config.livekit.url, token: await at.toJwt() });
  });

  // The client calls this after its websocket reconnects while it is still in a call. A server restart clears the
  // occupancy above, but LiveKit keeps the media flowing, so the client puts its slot back. No new token is issued.
  app.post('/api/voice/rejoin', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }

    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    const channel = serverId ? ctx.getChannel(channelId) : null;
    if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }

    occupy(ctx, channelId, userId);
    res.json({ ok: true });
  });

  app.post('/api/voice/leave', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }
    leaveChannel(ctx, channelId, userId);
    res.json({ ok: true });
  });

  // Server admins can remove someone from a call. Joining again is still allowed; this only ends the current call.
  app.post('/api/voice/kick', ctx.requireAuth, (req, res) => {
    const actorId = (req as AuthedRequest).userId;
    const body = (req.body ?? {}) as { channelId?: unknown; userId?: unknown };
    if (typeof body.channelId !== 'string' || typeof body.userId !== 'string') {
      res.status(400).json({ error: 'channelId and userId required' });
      return;
    }
    const channelId = body.channelId;
    const targetId = body.userId;
    const channel = ctx.getChannel(channelId);
    const actorRole = channel ? ctx.roleIn(channel.serverId, actorId) : null;
    if (!channel || !actorRole) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }
    if (actorRole === 'member') { res.status(403).json({ error: 'admins only' }); return; }
    if (targetId === actorId) { res.status(400).json({ error: 'use Leave voice to leave yourself' }); return; }
    if (!occupants.get(channelId)?.has(targetId)) { res.status(404).json({ error: 'they are not in this call' }); return; }
    // Same rule as removing a member from the server: admins cannot touch the owner or other admins.
    const targetRole = ctx.roleIn(channel.serverId, targetId);
    if (targetRole === 'owner' || (targetRole === 'admin' && actorRole !== 'owner')) {
      res.status(403).json({ error: 'you cannot kick this member' });
      return;
    }
    kickFromChannelCall(ctx, channelId, targetId);
    // Tells the kicked user's open sockets why their call ended. Joining again is still allowed.
    ctx.sendToUser(targetId, { t: 'voice.kicked', channelId });
    res.json({ ok: true });
  });

  // The client reports its own mic/speaker state so the server can refuse soundboard plays from silenced users.
  app.post('/api/voice/state', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const body = (req.body ?? {}) as { channelId?: unknown; muted?: unknown; deafened?: unknown };
    if (typeof body.channelId !== 'string' || typeof body.muted !== 'boolean' || typeof body.deafened !== 'boolean') {
      res.status(400).json({ error: 'channelId, muted and deafened required' }); return;
    }
    if (!isInVoiceChannel(body.channelId, userId)) { res.status(409).json({ error: 'join the voice channel first' }); return; }
    selfState.set(userId, { muted: body.muted, deafened: body.deafened });
    res.json({ ok: true });
  });

  app.get('/api/servers/:id/voice-state', ctx.requireAuth, (req, res) => {
    const serverId = req.params.id;
    if (!ctx.roleIn(serverId, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'server not found' }); return; }
    const rows = ctx.db.prepare("SELECT id FROM channels WHERE server_id=? AND kind='voice'").all(serverId) as { id: string }[];
    const channels: Record<string, string[]> = {};
    for (const { id } of rows) channels[id] = [...(occupants.get(id) ?? [])];
    res.json({ channels });
  });
}
