import { create } from 'zustand';
import type { Activity } from '@chatward/shared';
import { onFrame, sendFrame } from '../api/ws';
import { useSession } from './session';

// How often the app asks Spotify what is playing while sharing is on. Spotify's limits are per app, shared by the group.
const POLL_MS = 20_000;
const SHARE_KEY = 'chatward.spotify.share';

interface SpotifyState {
  /** The build has a Spotify app (false in dev builds and outside Electron). */
  available: boolean;
  connected: boolean;
  /** The person turned on "Show what I'm listening to". Remembered on this PC. */
  share: boolean;
  /** userId -> what they are listening to now. Our own entry is what we last sent. */
  activities: Record<string, Activity>;
  /** The last problem talking to Spotify, shown in Settings. */
  error: string | null;
  setActivity: (userId: string, activity: Activity | null) => void;
}

const savedShare = (() => { try { return localStorage.getItem(SHARE_KEY) === '1'; } catch { return false; } })();

export const useSpotify = create<SpotifyState>((set) => ({
  available: false,
  connected: false,
  share: savedShare,
  activities: {},
  error: null,
  setActivity: (userId, activity) => set((s) => {
    const activities = { ...s.activities };
    if (activity) activities[userId] = activity; else delete activities[userId];
    return { activities };
  }),
}));

const bridge = () => (typeof window !== 'undefined' ? window.chatward?.spotify : undefined);

/** What we last told the server, so an unchanged song isn't sent again every poll. */
let sent: Activity | null = null;

function publish(activity: Activity | null) {
  const me = useSession.getState().user?.id;
  if (me) useSpotify.getState().setActivity(me, activity);
  if (JSON.stringify(activity) === JSON.stringify(sent)) return;
  sent = activity;
  sendFrame({ t: 'activity', activity });
}

async function refreshStatus() {
  const s = await bridge()?.status().catch(() => null);
  useSpotify.setState({ available: !!s?.available, connected: !!s?.connected });
}

async function poll() {
  const { share, connected } = useSpotify.getState();
  const b = bridge();
  if (!b || !share || !connected) { publish(null); return; }
  const r = await b.nowPlaying();
  if (r.ok) {
    useSpotify.setState({ error: null });
    publish(r.track ? { kind: 'spotify', ...r.track } : null);
  } else {
    useSpotify.setState({ error: r.error, ...(r.signedOut ? { connected: false } : {}) });
    publish(null);
  }
}

export async function connectSpotify() {
  useSpotify.setState({ error: null });
  try {
    await bridge()?.connect();
  } catch (err) {
    // Electron wraps errors from the main process as "Error invoking remote method '...': Error: <message>".
    const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not connect Spotify.';
    useSpotify.setState({ error: msg });
  }
  await refreshStatus();
  void poll();
}

export async function disconnectSpotify() {
  await bridge()?.disconnect();
  useSpotify.setState({ error: null });
  await refreshStatus();
  publish(null);
}

export function setSpotifyShare(share: boolean) {
  try { localStorage.setItem(SHARE_KEY, share ? '1' : '0'); } catch { /* not remembered; still applies now */ }
  useSpotify.setState({ share });
  void poll();
}

/**
 * Starts sharing what the person listens to (when they turned it on) and keeps everyone else's activity up to date.
 * Returns a stop function. Called once the socket is set up.
 */
export function installSpotifyActivity(): () => void {
  sent = null;
  void refreshStatus().then(poll);
  const timer = setInterval(() => void poll(), POLL_MS);
  const off = onFrame((f) => {
    const st = useSpotify.getState();
    if (f.t === 'activity') st.setActivity(f.userId, f.activity);
    else if (f.t === 'presence' && f.status === 'offline') st.setActivity(f.userId, null);
    else if (f.t === 'ready') {
      // A new connection starts with nothing shared for us; the server sends everyone else's right after.
      useSpotify.setState({ activities: {} });
      const mine = sent;
      sent = null;
      publish(mine);
    }
  });
  return () => {
    clearInterval(timer);
    off();
    // Signing out: whatever was shown goes away with the socket.
    sent = null;
    useSpotify.setState({ activities: {} });
  };
}
