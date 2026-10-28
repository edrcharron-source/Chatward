import type { ClientFrame, ServerFrame } from '@chatward/shared';
import { useSession } from '../state/session';

type Handler = (f: ServerFrame) => void;
const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;
// Every socket gets an app-level ping this often, and is replaced if nothing at all has arrived for PING_TIMEOUT_MS.
// A sleeping PC or a dropped network often leaves the socket open on this side, so onclose would never fire.
const PING_MS = 25_000;
const PING_TIMEOUT_MS = 60_000;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let lastHeard = 0;

export function onFrame(h: Handler): () => void { handlers.add(h); return () => handlers.delete(h); }
export function sendFrame(f: ClientFrame) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(f)); }

export function connectWs() {
  wanted = true;
  const { serverUrl, token } = useSession.getState();
  if (!token || socket) return;
  const url = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?token=' + encodeURIComponent(token);
  const ws = (socket = new WebSocket(url));
  ws.onopen = () => {
    retry = 0;
    lastHeard = Date.now();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (Date.now() - lastHeard > PING_TIMEOUT_MS) { dropSocket(ws); return; }
      sendFrame({ t: 'ping' });
    }, PING_MS);
  };
  ws.onmessage = (e) => {
    lastHeard = Date.now();
    try { const f = JSON.parse(e.data) as ServerFrame; handlers.forEach((h) => h(f)); } catch { /* ignore */ }
  };
  ws.onclose = () => {
    // A replaced socket can still report its close late; only the current one may clear state and reconnect.
    if (socket !== ws) return;
    socket = null;
    clearInterval(pingTimer);
    if (!wanted) return;
    scheduleReconnect();
  };
}
function scheduleReconnect() {
  clearTimeout(timer);
  timer = setTimeout(connectWs, Math.min(15000, 500 * 2 ** retry++));
}
/** Gives up on a socket that has gone silent and reconnects now, without waiting for a close that may never come. */
function dropSocket(ws: WebSocket) {
  if (socket !== ws) return;
  socket = null;
  clearInterval(pingTimer);
  ws.close();
  if (wanted) scheduleReconnect();
}
export function disconnectWs() { wanted = false; clearTimeout(timer); clearInterval(pingTimer); socket?.close(); socket = null; }
