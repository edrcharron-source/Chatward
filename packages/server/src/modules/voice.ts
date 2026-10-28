import type { Express } from 'express';
import { AccessToken, RoomServiceClient, ServerError } from 'livekit-server-sdk';
import type { Ctx, AuthedRequest } from '../ctx.js';
import { perMember } from '../userLimit.js';

// In-memory voice occupancy. Lost on restart, which is fine: clients rejoin.
const occupants = new Map<string, Set<string>>(); // channelId -> userIds
const voiceChannelOf = new Map<string, string>(); // userId -> channelId (a user is in at most one VC)
const voiceDeviceOf = new Map<string, string>(); // userId -> the device that holds the voice slot
const selfState = new Map<string, { muted: boolean; deafened: boolean }>(); // userId -> self mute/deafen, reported by the client

// Only needed to join, but livekit-client reuses this token when it reconnects after a network drop, so it must outlive
// a short blip. Kicks and bans are enforced by removeParticipant, not by token expiry.
const TOKEN_TTL = '10m';
const TOKEN_TTL_MS = 10 * 60_000; // keep in step with TOKEN_TTL

// A removed user's token from before the removal stays valid until it expires, and livekit-client reuses it to reconnect.
// So after a removal, the room is cleared again every EVICT_EVERY_MS until that token is gone. A fresh token for the room
// (the user is allowed back in) stops it early.
const EVICT_EVERY_MS = 20_000;
// roomId:userId -> the repeat timer and the timer that ends it
const evictions = new Map<string, { repeat: ReturnType<typeof setInterval>; end: ReturnType<typeof setTimeout> }>();
// roomId:userId -> when the user last got a token for the room. A room with any token needs the repeat, because LiveKit
// refreshes the token while the call runs, so the reusable one can be newer than the join. Pruned when the repeat ends.
const lastToken = new Map<string, number>();
// roomId:userId -> removed, and the repeat has ended. The LiveKit removal may have failed for the whole window (LiveKit's
// API down), so the user may still be in the room. A rejoin is refused until they get a fresh token for it.
const removedFromRoom = new Set<string>();

// A dropped websocket does not end a call: LiveKit keeps the media flowing. Hold the voice slot this long so a
// quick reconnect keeps it. Kicks and explicit leaves ignore this and still act at once.
const VOICE_GRACE_MS = 30_000;
// userId -> pending slot removal. channelId and deviceId identify the slot the timer was started for, so it never ends a
// newer call. deviceId is null when the slot is not tied to a device.
const graceTimers = new Map<string, { channelId: string; deviceId: string | null; timer: ReturnType<typeof setTimeout> }>();

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
  const pending = graceTimers.get(userId);
  if (!pending) return;
  clearTimeout(pending.timer);
  graceTimers.delete(userId);
}

/** True if another device of the account holds the voice slot, so this device must not take or change it. */
function heldByOtherDevice(userId: string, deviceId: string | undefined): boolean {
  const holder = voiceDeviceOf.get(userId);
  return !!holder && !!deviceId && holder !== deviceId;
}

/**
 * For a server kick: drops the user from voice, then removes them from every voice room on the server, so they stop
 * receiving media now. Not used on a dropped socket, where a reconnect should keep the call. Checks every room
 * rather than the in-memory occupancy, which a dropped socket may have cleared.
 */
export function kickFromCall(ctx: Ctx, serverId: string, userId: string): void {
  // Only drop the slot if the call is on this server. A call the user holds in another server stays.
  const heldChannel = voiceChannelOf.get(userId);
  if (heldChannel && ctx.getChannel(heldChannel)?.serverId === serverId) leaveVoice(ctx, userId);
  const channels = ctx.db.prepare("SELECT id FROM channels WHERE server_id=? AND kind='voice'").all(serverId) as { id: string }[];
  for (const { id } of channels) evictFromRoom(ctx, id, userId);
}

/**
 * For a removed device: if that device holds the call, ends the call for the account. Every device of an account shares
 * one LiveKit identity, so the session cannot be ended per device. A call on another device is left alone.
 */
export function endCallOnDevice(ctx: Ctx, userId: string, deviceId: string): void {
  if (voiceDeviceOf.get(userId) !== deviceId) return;
  endCall(ctx, userId);
}

/**
 * For a password change or reset, which signs out every device except the one it was made from. If the call runs on
 * any other device, it ends for the account. A call on the device that stays signed in is left alone.
 */
export function endCallOnOtherDevices(ctx: Ctx, userId: string, keepDeviceId: string): void {
  if (!voiceChannelOf.has(userId) || voiceDeviceOf.get(userId) === keepDeviceId) return;
  endCall(ctx, userId);
}

/** For an account delete, which signs out every device. If the account is in a call on any device, the call ends. */
export function endAccountCall(ctx: Ctx, userId: string): void {
  if (voiceChannelOf.has(userId)) endCall(ctx, userId);
}

/** Drops the account's call and its LiveKit session, in one place for the device-based endings above. */
function endCall(ctx: Ctx, userId: string): void {
  const channelId = voiceChannelOf.get(userId);
  leaveVoice(ctx, userId);
  if (channelId) evictFromRoom(ctx, channelId, userId);
}

/** Drops the user from the channel's voice slot and from the LiveKit room, so they stop hearing the call now. */
function kickFromChannelCall(ctx: Ctx, channelId: string, userId: string): void {
  leaveChannel(ctx, channelId, userId);
  evictFromRoom(ctx, channelId, userId);
}

function roomService(ctx: Ctx): RoomServiceClient {
  return new RoomServiceClient(ctx.config.livekit.apiUrl, ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret);
}

/** Ends the user's LiveKit session in a room. Fails if LiveKit no longer has them (already left or still connecting). */
function removeFromRoom(ctx: Ctx, channelId: string, userId: string, quiet = false): void {
  roomService(ctx).removeParticipant(channelId, userId).catch((err: unknown) => {
    if (!quiet) console.warn('livekit removeParticipant failed', err);
  });
}

// How long a rejoin waits for LiveKit to say whether the user is in the room before it gives up on the lookup.
const ROOM_LOOKUP_MS = 3_000;

/**
 * Asks LiveKit whether the user is in the room. 'absent' only when LiveKit itself says so. A failed or slow lookup is
 * 'unknown': the user may still be in the call, so the caller must not treat it as a refusal.
 */
async function lookupInRoom(ctx: Ctx, channelId: string, userId: string): Promise<'in' | 'absent' | 'unknown'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unknown'>((resolve) => { timer = setTimeout(() => resolve('unknown'), ROOM_LOOKUP_MS); });
  const lookup = roomService(ctx).getParticipant(channelId, userId).then(
    () => 'in' as const,
    (err: unknown) => (err instanceof ServerError && err.code === 'not_found' ? 'absent' as const : 'unknown' as const),
  );
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Rejoins that get no answer from LiveKit in a row. Logged once the streak is long enough, then at most once per interval,
// so a LiveKit that is down for good shows in the server log and not only as client errors.
const LOOKUP_FAIL_LOG_AFTER = 5;
const LOOKUP_FAIL_LOG_EVERY_MS = 5 * 60_000;
let lookupFailures = 0;
let lookupFailureLoggedAt = 0;

function noteLookup(ctx: Ctx, result: 'in' | 'absent' | 'unknown'): void {
  if (result !== 'unknown') { lookupFailures = 0; return; }
  lookupFailures += 1;
  if (lookupFailures < LOOKUP_FAIL_LOG_AFTER) return;
  const now = Date.now();
  if (now - lookupFailureLoggedAt < LOOKUP_FAIL_LOG_EVERY_MS) return;
  lookupFailureLoggedAt = now;
  console.error(`LiveKit room lookups failed ${lookupFailures} times in a row (${ctx.config.livekit.apiUrl}). Rejoins get 503 until it answers.`);
}

/**
 * For a removal (kick, ban, leave from the server, deleted channel or device): ends the session now, then keeps ending it
 * for TOKEN_TTL_MS. The window runs from the removal, not from the join, because LiveKit's refreshed tokens can outlive
 * the join token. Failing while the user is not in the room is expected.
 */
function evictFromRoom(ctx: Ctx, channelId: string, userId: string): void {
  removeFromRoom(ctx, channelId, userId);
  stopEviction(channelId, userId);
  const key = `${channelId}:${userId}`;
  // Rooms the user never got a token for cannot be rejoined on an old token, so no repeat.
  if (!lastToken.has(key)) return;
  const repeat = setInterval(() => removeFromRoom(ctx, channelId, userId, true), EVICT_EVERY_MS);
  const end = setTimeout(() => {
    stopEviction(channelId, userId);
    lastToken.delete(key);
    removedFromRoom.add(key);
  }, TOKEN_TTL_MS);
  // Timers must not keep the process alive on shutdown.
  repeat.unref();
  end.unref();
  evictions.set(key, { repeat, end });
}

/** Ends the repeated removal for a room, e.g. once the user has a fresh token for it. */
function stopEviction(channelId: string, userId: string): void {
  const key = `${channelId}:${userId}`;
  const pending = evictions.get(key);
  if (!pending) return;
  clearInterval(pending.repeat);
  clearTimeout(pending.end);
  evictions.delete(key);
}

/** Puts the user in the channel's voice slot, leaving any other voice channel they hold. */
function occupy(ctx: Ctx, channelId: string, userId: string, deviceId: string | undefined): void {
  const previous = voiceChannelOf.get(userId);
  if (previous && previous !== channelId) leaveChannel(ctx, previous, userId);
  if (deviceId) voiceDeviceOf.set(userId, deviceId);

  let set = occupants.get(channelId);
  if (!set) occupants.set(channelId, (set = new Set()));
  if (!set.has(userId)) {
    set.add(userId);
    voiceChannelOf.set(userId, channelId);
    broadcastState(ctx, channelId);
  }
}

/** Empties a voice channel, e.g. when the channel is deleted. Ends the LiveKit sessions too, so media stops now. */
export function clearVoiceChannel(ctx: Ctx, channelId: string): void {
  for (const userId of [...(occupants.get(channelId) ?? [])]) {
    leaveChannel(ctx, channelId, userId);
    evictFromRoom(ctx, channelId, userId);
  }
}

function leaveChannel(ctx: Ctx, channelId: string, userId: string): boolean {
  const set = occupants.get(channelId);
  if (!set?.has(userId)) return false;
  // The slot is going away, so a grace timer started for it must not run later and touch whatever the account joins next.
  cancelGrace(userId);
  set.delete(userId);
  if (set.size === 0) occupants.delete(channelId);
  voiceChannelOf.delete(userId);
  voiceDeviceOf.delete(userId);
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

const LIVEKIT_CHECK_EVERY_MS = 5_000; // LiveKit often starts a few seconds after the server
const LIVEKIT_CHECK_QUICK_TRIES = 12; // about a minute of quick checks before a failure is logged
const LIVEKIT_CHECK_SLOW_MS = 60_000; // after that, keep checking once a minute until it answers

/**
 * Logs whether LiveKit's API answers with the configured URL and keys. Only logs: a failure does not stop the server.
 * Retries until it answers, so a LiveKit that is still starting does not leave a false error in the log.
 */
function checkLiveKitApi(ctx: Ctx): void {
  const { apiUrl } = ctx.config.livekit;
  let tries = 0;
  const attempt = (): void => {
    tries += 1;
    roomService(ctx).listRooms().then(
      () => console.log(`LiveKit API check ok (${apiUrl})`),
      (err: unknown) => {
        if (tries === LIVEKIT_CHECK_QUICK_TRIES) console.error(
          `LiveKit API check failed (${apiUrl}). Check LIVEKIT_API_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET. Rejoins and kicks fail until this works.`,
          err,
        );
        setTimeout(attempt, tries < LIVEKIT_CHECK_QUICK_TRIES ? LIVEKIT_CHECK_EVERY_MS : LIVEKIT_CHECK_SLOW_MS);
      },
    );
  };
  attempt();
}

export function register(app: Express, ctx: Ctx): void {
  checkLiveKitApi(ctx);
  // The slot's device lost its last socket: keep the slot for the grace period, so a quick reconnect keeps the call. A
  // second device staying online does not hold a crashed device's slot. A slot with no device waits for the account's
  // last socket instead, as before device-bound slots.
  ctx.onDisconnect.push((userId, deviceId, online) => {
    if (!voiceChannelOf.has(userId)) return;
    const slotDevice = voiceDeviceOf.get(userId) ?? null;
    const slotFree = slotDevice ? deviceId === slotDevice && !online.device : !online.user;
    if (!slotFree) return;
    cancelGrace(userId);
    const channelId = voiceChannelOf.get(userId);
    if (!channelId) return;
    const timer = setTimeout(() => {
      graceTimers.delete(userId);
      // Only end the slot this timer was started for. If the account has since joined another call or device, leave it alone.
      if (voiceChannelOf.get(userId) !== channelId || (voiceDeviceOf.get(userId) ?? null) !== slotDevice) return;
      leaveVoice(ctx, userId);
    }, VOICE_GRACE_MS);
    graceTimers.set(userId, { channelId, deviceId: slotDevice, timer });
  });
  // A reconnect cancels the grace only for the device it waits on. Another device connecting leaves it running.
  ctx.onConnect.push((userId, deviceId) => {
    const pending = graceTimers.get(userId);
    if (pending && (pending.deviceId === null || pending.deviceId === deviceId)) cancelGrace(userId);
  });

  app.post('/api/voice/token', ctx.requireAuth, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
      if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }

      const serverId = ctx.serverIdForChannelMember(channelId, userId);
      const channel = serverId ? ctx.getChannel(channelId) : null;
      if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
      if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }

      // Every device of an account uses the same LiveKit identity, and LiveKit drops the older session when a second one
      // joins the same room. So a second device is refused while the first is still in the call. A slot held by this
      // device itself is a leftover (for example a missed leave), so the device may take it again.
      if (voiceChannelOf.get(userId) === channelId && heldByOtherDevice(userId, (req as AuthedRequest).deviceId)) {
        res.status(409).json({ error: 'You are already in this call on another device. Leave the call there first.' });
        return;
      }
      // A fresh token means the user is allowed in this room again, so stop clearing it for an earlier removal.
      stopEviction(channelId, userId);
      removedFromRoom.delete(`${channelId}:${userId}`);
      lastToken.set(`${channelId}:${userId}`, Date.now());

      // Joining a channel implicitly leaves any other voice channel. The account may still hold that channel on another
      // device. LiveKit keeps that device's session in the old room, so end it there and tell the account's sockets, so
      // the other device hangs up instead of staying silently in the call.
      const previous = voiceChannelOf.get(userId);
      if (previous && previous !== channelId) {
        removeFromRoom(ctx, previous, userId);
        ctx.sendToUser(userId, { t: 'voice.moved', channelId: previous });
      }
      occupy(ctx, channelId, userId, (req as AuthedRequest).deviceId);
      // The client sends its mute state with the join, so soundboard refuses a muted joiner from the first moment.
      // Older clients send nothing here, which counts as unmuted, as before.
      const body = (req.body ?? {}) as { muted?: unknown; deafened?: unknown };
      selfState.set(userId, { muted: body.muted === true, deafened: body.deafened === true });

      const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, {
        identity: userId,
        name: ctx.getUser(userId)?.displayName,
        ttl: TOKEN_TTL,
      });
      at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });
      res.json({ url: ctx.config.livekit.url, token: await at.toJwt() });
    } catch (err) {
      next(err);
    }
  });

  // The client calls this after its websocket reconnects while it is still in a call. A server restart clears the
  // occupancy above, but LiveKit keeps the media flowing, so the client puts its slot back. No new token is issued.
  // The client also reports its mute state here, since the server clears it along with the slot.
  app.post('/api/voice/rejoin', ctx.requireAuth, perMember(60_000, 30), async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const body = (req.body ?? {}) as { channelId?: unknown; muted?: unknown; deafened?: unknown };
    const channelId = body.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }

    const serverId = ctx.serverIdForChannelMember(channelId, userId);
    const channel = serverId ? ctx.getChannel(channelId) : null;
    if (!channel) { res.status(404).json({ error: 'channel not found' }); return; }
    if (channel.kind !== 'voice') { res.status(400).json({ error: 'not a voice channel' }); return; }
    const { deviceId } = req as AuthedRequest;
    const key = `${channelId}:${userId}`;
    if (heldByOtherDevice(userId, deviceId)) { res.status(409).json({ error: 'The call is on another device.' }); return; }
    // Removed from this call and the removal is still being enforced. Putting the slot back would show them in the call
    // until the next sweep, so refuse. The client then hangs up. A fresh join clears the removal.
    if (evictions.has(key) || removedFromRoom.has(key)) { res.status(409).json({ error: 'You were removed from this call.' }); return; }
    // Without a slot here, the user must be in the LiveKit room. A token's age does not show that: LiveKit refreshes the
    // token inside a call, so a call can outlive the join token. Only LiveKit can say whether the session is still there,
    // and a room the user never joined has no session, so any member still cannot show themselves in it. A slot that is
    // already there is trusted as before.
    if (!isInVoiceChannel(channelId, userId)) {
      // Set before the lookup, so a removal that lands during it starts the repeat. After a restart this is the only
      // token record the room has, and the client still holds the token from before the restart.
      lastToken.set(key, Date.now());
      const inRoom = await lookupInRoom(ctx, channelId, userId);
      noteLookup(ctx, inRoom);
      // LiveKit could not answer, which says nothing about the call. The client retries rather than hanging up.
      if (inRoom === 'unknown') {
        res.status(503).json({ error: 'Could not reach the call server. Try again shortly.', code: 'lookup_unavailable' });
        return;
      }
      if (inRoom === 'absent') {
        res.status(409).json({ error: 'You are not in this call. Join it again.', code: 'not_in_room' });
        return;
      }
    }

    // The lookup took time. A removal, a ban or a second device may have landed meanwhile, so check again before the slot
    // goes back.
    if (evictions.has(key) || removedFromRoom.has(key)) { res.status(409).json({ error: 'You were removed from this call.' }); return; }
    if (heldByOtherDevice(userId, deviceId)) { res.status(409).json({ error: 'The call is on another device.' }); return; }
    if (!ctx.serverIdForChannelMember(channelId, userId)) { res.status(404).json({ error: 'channel not found' }); return; }

    // Moving from another voice channel works like a join: end the old room and tell the account's other sockets.
    const previous = voiceChannelOf.get(userId);
    if (previous && previous !== channelId) {
      removeFromRoom(ctx, previous, userId);
      ctx.sendToUser(userId, { t: 'voice.moved', channelId: previous });
    }
    occupy(ctx, channelId, userId, deviceId);
    selfState.set(userId, { muted: body.muted === true, deafened: body.deafened === true });
    res.json({ ok: true });
  });

  // Only the device that holds the slot may end it. A second device whose join was refused must not clear the first
  // device's slot while that device is still in the call.
  app.post('/api/voice/leave', ctx.requireAuth, (req, res) => {
    const { userId, deviceId } = req as AuthedRequest;
    const channelId = (req.body as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId !== 'string') { res.status(400).json({ error: 'channelId required' }); return; }
    const holder = voiceDeviceOf.get(userId);
    if (holder && holder !== deviceId) { res.status(409).json({ error: 'The call is held by another device.' }); return; }
    leaveChannel(ctx, channelId, userId);
    res.json({ ok: true });
  });

  // A client that starts up with no call of its own calls this. After a restart or crash the old slot has no client left
  // to end it, and the 409 above would lock the user out. Clears the voice slot only when this device holds it, so a
  // second device starting up cannot end a call running on the first. The device comes from the signed token.
  app.post('/api/voice/clear', ctx.requireAuth, (req, res) => {
    const { userId, deviceId } = req as AuthedRequest;
    if (voiceDeviceOf.get(userId) === deviceId) leaveVoice(ctx, userId);
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
    // Same rule as removing a member from the server: admins cannot touch the owner or other admins.
    const targetRole = ctx.roleIn(channel.serverId, targetId);
    if (!targetRole) { res.status(404).json({ error: 'they are not in this server' }); return; }
    if (targetRole === 'owner' || (targetRole === 'admin' && actorRole !== 'owner')) {
      res.status(403).json({ error: 'you cannot kick this member' });
      return;
    }
    // Always ends the LiveKit session, even when the voice slot is already gone (a dropped socket or a restart) and
    // media still flows. LiveKit ignores a removal for someone who is not in the room.
    kickFromChannelCall(ctx, channelId, targetId);
    // Tells the kicked user's open sockets why their call ended. Joining again is still allowed.
    ctx.sendToUser(targetId, { t: 'voice.kicked', channelId });
    res.json({ ok: true });
  });

  // The client reports its own mic/speaker state so the server can refuse soundboard plays from silenced users.
  app.post('/api/voice/state', ctx.requireAuth, (req, res) => {
    const { userId, deviceId } = req as AuthedRequest;
    const body = (req.body ?? {}) as { channelId?: unknown; muted?: unknown; deafened?: unknown };
    if (typeof body.channelId !== 'string' || typeof body.muted !== 'boolean' || typeof body.deafened !== 'boolean') {
      res.status(400).json({ error: 'channelId, muted and deafened required' }); return;
    }
    if (!isInVoiceChannel(body.channelId, userId)) { res.status(409).json({ error: 'join the voice channel first' }); return; }
    // Another device's state must not overwrite the mute state of the call on this one.
    if (heldByOtherDevice(userId, deviceId)) { res.status(409).json({ error: 'The call is on another device.' }); return; }
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
