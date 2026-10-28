import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientFrame, ServerFrame } from '@chatward/shared';
import type { Ctx } from './ctx.js';

export function attachWs(http: HttpServer, ctx: Ctx) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const socketsByUser = new Map<string, Set<WebSocket>>();

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const userId = ctx.verifyToken(url.searchParams.get('token') ?? '');
    if (!userId) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = socketsByUser.get(userId);
      if (!set) socketsByUser.set(userId, (set = new Set()));
      set.add(ws);
      send(ws, { t: 'ready', user: ctx.getUser(userId)! });
      announce(userId, 'online');
      ws.on('message', (raw) => {
        let f: ClientFrame;
        try { f = JSON.parse(raw.toString()); } catch { return; }
        if (f.t === 'ping') send(ws, { t: 'pong' });
        else if (f.t === 'typing') {
          const sid = ctx.serverIdForChannelMember(f.channelId, userId);
          if (sid) ctx.broadcastToServer(sid, { t: 'typing', channelId: f.channelId, userId });
        } else if (f.t === 'presence') announce(userId, f.status);
      });
      ws.on('close', () => {
        set!.delete(ws);
        if (set!.size === 0) { socketsByUser.delete(userId); announce(userId, 'offline'); for (const cb of ctx.onDisconnect) cb(userId); }
      });
    });
  });

  function send(ws: WebSocket, f: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }
  function announce(userId: string, status: 'online' | 'idle' | 'dnd' | 'offline') {
    const rows = ctx.db.prepare('SELECT server_id FROM members WHERE user_id=?').all(userId) as { server_id: string }[];
    for (const r of rows) ctx.broadcastToServer(r.server_id, { t: 'presence', userId, status });
  }

  ctx.sendToUser = (userId, frame) => {
    for (const ws of socketsByUser.get(userId) ?? []) send(ws, frame);
  };
  ctx.broadcastToServer = (serverId, frame) => {
    const ids = ctx.db.prepare('SELECT user_id FROM members WHERE server_id=?').all(serverId) as { user_id: string }[];
    for (const { user_id } of ids) ctx.sendToUser(user_id, frame);
  };
}
