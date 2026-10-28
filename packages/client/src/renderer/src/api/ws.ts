import type { ClientFrame, ServerFrame } from '@chatward/shared';
import { useSession } from '../state/session';
import { api, ApiError } from './http';

type Handler = (f: ServerFrame) => void;
const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

export function onFrame(h: Handler): () => void { handlers.add(h); return () => handlers.delete(h); }
export function sendFrame(f: ClientFrame) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(f)); }

export function connectWs() {
  wanted = true;
  const { serverUrl, token } = useSession.getState();
  if (!token || socket) return;
  const url = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?token=' + encodeURIComponent(token);
  let opened = false;
  const ws = (socket = new WebSocket(url));
  ws.onopen = () => { opened = true; retry = 0; };
  ws.onmessage = (e) => { try { const f = JSON.parse(e.data) as ServerFrame; handlers.forEach((h) => h(f)); } catch { /* ignore */ } };
  ws.onclose = () => {
    socket = null;
    if (!wanted) return;
    // A browser socket cannot show the HTTP status of a refused handshake, so a socket that never opened asks the server over HTTP.
    // A 401 there signs the user out (http.ts does that), and then the retries stop.
    if (opened) scheduleRetry();
    else void api.get('/api/me').then(scheduleRetry, (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) scheduleRetry(); });
  };
}

function scheduleRetry() {
  if (!wanted) return;
  clearTimeout(timer);
  timer = setTimeout(connectWs, Math.min(15000, 500 * 2 ** retry++));
}
export function disconnectWs() { wanted = false; clearTimeout(timer); socket?.close(); socket = null; }
