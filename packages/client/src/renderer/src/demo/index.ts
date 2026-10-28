// Demo mode entry. Owner: demo-backend thread. Keep the exported signatures stable.
import type { ServerFrame } from '@chatward/shared';
import { signOut, useSession } from '../state/session';
import { attachSocket, demoFetch, demoUser, DEMO_TOKEN, startDemoWorld, stopDemoWorld } from './backend';

export const DEMO_URL = 'http://demo.chatward.local';
const DEMO_HOST = 'demo.chatward.local';
const DEFAULT_URL = 'http://localhost:3000';

/** True while the app is running against the in-process mock backend. */
export function isDemo(): boolean {
  return useSession.getState().serverUrl === DEMO_URL;
}

let installed = false;
let previousUrl: string | null = null;
const realFetch = window.fetch.bind(window);
const RealWebSocket = window.WebSocket;

/** Route every request and socket for the demo host to the in-memory backend. Everything else passes through. */
export function installDemoNetwork(): void {
  if (installed) return;
  installed = true;
  startDemoWorld();
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== DEMO_HOST) return realFetch(input, init);
    return demoFetch(url, init ?? {});
  };
  window.WebSocket = DemoWebSocket as unknown as typeof WebSocket;
}

function removeDemoNetwork(): void {
  if (!installed) return;
  installed = false;
  stopDemoWorld();
  window.fetch = realFetch;
  window.WebSocket = RealWebSocket;
}

/** Stands in for WebSocket on the demo host. Frames come from the in-memory backend. */
class DemoWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = DemoWebSocket.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private detach: (() => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      if (this.readyState !== DemoWebSocket.CONNECTING) return;
      this.readyState = DemoWebSocket.OPEN;
      this.detach = attachSocket((frame: ServerFrame) => {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
      });
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(_data: string): void {
    // The mock server only pushes; client frames (typing, presence, ping) need no reply offline.
  }

  close(): void {
    if (this.readyState === DemoWebSocket.CLOSED) return;
    this.readyState = DemoWebSocket.CLOSED;
    this.detach?.();
    this.detach = null;
    this.onclose?.(new CloseEvent('close'));
  }
}

/** Switch to demo: install network interceptors, fake sign-in as "You". */
export async function enterDemo(): Promise<void> {
  const s = useSession.getState();
  if (s.serverUrl !== DEMO_URL) previousUrl = s.serverUrl;
  installDemoNetwork();
  s.setServerUrl(DEMO_URL);
  s.setAuth(DEMO_TOKEN, demoUser());
}

/** Leave demo: remove interceptors, log out, restore the previous server URL. */
export async function exitDemo(): Promise<void> {
  await signOut();
  useSession.getState().setServerUrl(previousUrl ?? DEFAULT_URL);
  removeDemoNetwork();
}

// A reload while in demo mode must come back with the network shim already in place.
if (isDemo()) installDemoNetwork();
