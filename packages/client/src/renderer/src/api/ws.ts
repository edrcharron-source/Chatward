import type { ClientFrame, ServerFrame } from '@chatward/shared';
import { useSession } from '../state/session';

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
  const ws = (socket = new WebSocket(url));
  ws.onopen = () => { retry = 0; };
  ws.onmessage = (e) => { try { const f = JSON.parse(e.data) as ServerFrame; handlers.forEach((h) => h(f)); } catch { /* ignore */ } };
  ws.onclose = () => {
    socket = null;
    if (!wanted) return;
    clearTimeout(timer);
    timer = setTimeout(connectWs, Math.min(15000, 500 * 2 ** retry++));
  };
}
export function disconnectWs() { wanted = false; clearTimeout(timer); socket?.close(); socket = null; }
