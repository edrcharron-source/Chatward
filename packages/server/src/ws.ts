import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientFrame, ServerFrame } from '@chatward/shared';
import type { Ctx } from './ctx.js';

// How often the server pings every socket. A socket that has not answered the previous ping is dead
// (a laptop that slept or lost Wi-Fi never sends a close), so it is terminated and its user goes offline.
const HEARTBEAT_MS = 30_000;

type AliveSocket = WebSocket & { isAlive?: boolean };

export function attachWs(http: HttpServer, ctx: Ctx) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const socketsByUser = new Map<string, Set<WebSocket>>();
  // Last status each connected user announced, so a new connection can be told who is online right now.
  const statusByUser = new Map<string, 'online' | 'idle' | 'dnd'>();
  // The only statuses a client may set; 'offline' is decided by the server, never by the client.
  const CLIENT_STATUSES: string[] = ['online', 'idle', 'dnd'];
  // Which device each socket belongs to, so removing one device closes only its sockets.
  const deviceBySocket = new WeakMap<WebSocket, string | null>();

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const session = ctx.verifySession(url.searchParams.get('token') ?? '');
    if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const { userId, deviceId } = session;
    wss.handleUpgrade(req, socket, head, (ws: AliveSocket) => {
      ws.isAlive = true;
      // Each pong proves the socket is still alive, so this device has seen everything up to now.
      // Without this, a server restart would replay alerts the device already showed this session.
      ws.on('pong', () => { ws.isAlive = true; markDeviceSeen(deviceId); });
      let set = socketsByUser.get(userId);
      if (!set) socketsByUser.set(userId, (set = new Set()));
      set.add(ws);
      deviceBySocket.set(ws, deviceId);
      statusByUser.set(userId, 'online');
      for (const cb of ctx.onConnect) cb(userId, deviceId);
      send(ws, { t: 'ready', user: ctx.getUser(userId)!, presence: presenceFor(userId) });
      sendPresenceSnapshot(ws, userId);
      replayNewDeviceAlerts(ws, userId, deviceId);
      announce(userId, 'online');
      ws.on('message', (raw) => {
        let f: ClientFrame;
        try { f = JSON.parse(raw.toString()); } catch { return; }
        if (!f || typeof f !== 'object') return;
        if (f.t === 'ping') send(ws, { t: 'pong' });
        else if (f.t === 'typing') {
          const sid = ctx.serverIdForChannelMember(f.channelId, userId);
          if (sid) ctx.broadcastToServer(sid, { t: 'typing', channelId: f.channelId, userId });
        } else if (f.t === 'presence' && CLIENT_STATUSES.includes(f.status)) announce(userId, f.status);
      });
      ws.on('close', () => {
        markDeviceSeen(deviceId);
        set!.delete(ws);
        if (set!.size === 0) { socketsByUser.delete(userId); statusByUser.delete(userId); announce(userId, 'offline'); }
        const online = {
          device: [...set!].some((other) => deviceBySocket.get(other) === deviceId),
          user: set!.size > 0,
        };
        for (const cb of ctx.onDisconnect) cb(userId, deviceId, online);
      });
    });
  });

  // terminate() emits 'close' on the socket, so the normal cleanup above marks the user offline.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<AliveSocket>) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  function send(ws: WebSocket, f: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }
  /** Who is online among the people who share a server with userId, so a reconnecting client can rebuild presence. */
  function presenceFor(userId: string) {
    const out: Record<string, 'online' | 'idle' | 'dnd'> = {};
    const rows = ctx.db.prepare(
      'SELECT DISTINCT b.user_id AS user_id FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=?',
    ).all(userId) as { user_id: string }[];
    for (const { user_id } of rows) {
      const status = statusByUser.get(user_id);
      if (status) out[user_id] = status;
    }
    return out;
  }
  function announce(userId: string, status: 'online' | 'idle' | 'dnd' | 'offline') {
    if (status === 'offline') statusByUser.delete(userId);
    else statusByUser.set(userId, status);
    const rows = ctx.db.prepare('SELECT server_id FROM members WHERE user_id=?').all(userId) as { server_id: string }[];
    for (const r of rows) ctx.broadcastToServer(r.server_id, { t: 'presence', userId, status });
  }
  // Tells a freshly connected socket the current status of everyone it shares a server with,
  // so members who were already online don't show as Offline until they next change status.
  function sendPresenceSnapshot(ws: WebSocket, userId: string) {
    const rows = ctx.db.prepare(
      'SELECT DISTINCT m2.user_id AS userId FROM members m1 JOIN members m2 ON m2.server_id=m1.server_id WHERE m1.user_id=? AND m2.user_id<>?',
    ).all(userId, userId) as { userId: string }[];
    for (const { userId: other } of rows) {
      const status = statusByUser.get(other);
      if (status) send(ws, { t: 'presence', userId: other, status });
    }
  }

  /**
   * A new-device alert only reaches open sockets, so a sign-in made while every device was offline would never be announced.
   * Replays the alerts for devices added since this device last had a socket open.
   */
  function replayNewDeviceAlerts(ws: WebSocket, userId: string, deviceId: string | null) {
    if (!deviceId) return;
    const since = ctx.db.prepare('SELECT COALESCE(last_seen, created_at) AS since FROM devices WHERE device_id=? AND user_id=?')
      .get(deviceId, userId) as { since: number } | undefined;
    if (!since) return;
    const added = ctx.db.prepare(
      'SELECT device_id AS deviceId, created_at AS createdAt FROM devices WHERE user_id=? AND device_id<>? AND created_at>? ORDER BY created_at',
    ).all(userId, deviceId, since.since) as { deviceId: string; createdAt: number }[];
    for (const f of added) send(ws, { t: 'device.added', ...f });
    markDeviceSeen(deviceId);
  }
  /** Records that this device has a socket open now, so only devices added after this moment are replayed next time. */
  function markDeviceSeen(deviceId: string | null) {
    if (deviceId) ctx.db.prepare('UPDATE devices SET last_seen=? WHERE device_id=?').run(Date.now(), deviceId);
  }

  ctx.sendToUser = (userId, frame) => {
    for (const ws of socketsByUser.get(userId) ?? []) send(ws, frame);
  };
  ctx.broadcastToServer = (serverId, frame) => {
    const ids = ctx.db.prepare('SELECT user_id FROM members WHERE server_id=?').all(serverId) as { user_id: string }[];
    for (const { user_id } of ids) ctx.sendToUser(user_id, frame);
  };
  ctx.revokeSockets = (userId, deviceId) => {
    // 4401: the client reconnects with its current token, which is the new one if this session made the change.
    // A removed device's token no longer verifies, so its reconnect is refused and it stays offline.
    for (const ws of socketsByUser.get(userId) ?? []) {
      if (deviceId === undefined || deviceBySocket.get(ws) === deviceId) ws.close(4401, 'session revoked');
    }
  };
}
