import type { Express } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import type { Ctx, AuthedRequest } from '../ctx.js';

// In-memory voice occupancy. Lost on restart, which is fine: clients rejoin.
const occupants = new Map<string, Set<string>>(); // channelId -> userIds
const voiceChannelOf = new Map<string, string>(); // userId -> channelId (a user is in at most one VC)

const TOKEN_TTL = '1h';

/** True if the user currently holds a voice slot in this channel. Used by soundboard. */
export function isInVoiceChannel(channelId: string, userId: string): boolean {
  return occupants.get(channelId)?.has(userId) ?? false;
}

/** Removes the user from whatever voice channel they are in. For ctx.onDisconnect and kicks. */
export function leaveVoice(ctx: Ctx, userId: string): void {
  const channelId = voiceChannelOf.get(userId);
  if (channelId) leaveChannel(ctx, channelId, userId);
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
  ctx.onDisconnect.push((userId) => leaveVoice(ctx, userId));

  app.post('/api/voice/token', ctx.requireAuth, async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }

    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    const channel = serverId ? ctx.getChannel(channelId) : null;
    if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }

    // Joining a channel implicitly leaves any other voice channel.
    const previous = voiceChannelOf.get(userId);
    if (previous && previous !== channelId) leaveChannel(ctx, previous, userId);

    let set = occupants.get(channelId);
    if (!set) occupants.set(channelId, (set = new Set()));
    if (!set.has(userId)) {
      set.add(userId);
      voiceChannelOf.set(userId, channelId);
      broadcastState(ctx, channelId);
    }

    const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, {
      identity: userId,
      name: ctx.getUser(userId)?.displayName,
      ttl: TOKEN_TTL,
    });
    at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });
    res.json({ url: ctx.config.livekit.url, token: await at.toJwt() });
  });

  app.post('/api/voice/leave', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }
    leaveChannel(ctx, channelId, userId);
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
