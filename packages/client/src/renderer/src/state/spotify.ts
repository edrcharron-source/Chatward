import { create } from 'zustand';
import type { Activity } from '@chatward/shared';
import { onFrame, sendFrame } from '../api/ws';
import { useSession } from './session';

// How often the app asks Spotify what is playing while sharing is on. Spotify's limits are per app, shared by the group.
const POLL_MS = 20_000;
// A position this far off what we expect means the song was skipped or scrubbed, so the new position is sent.
const SEEK_MS = 10_000;
const SHARE_KEY = 'chatward.spotify.share';

interface SpotifyState {
  /** The build has a Spotify app (false in dev builds and outside Electron). */
  available: boolean;
  connected: boolean;
  /** The person turned on "Show what I'm listening to". Remembered on this PC. */
  share: boolean;
  /** userId -> what they are listening to now. Our own entry is what we last sent. */
  activities: Record<string, Activity>;
  /** userId -> when (our clock) the current activity arrived. Used to move the song position on. */
  since: Record<string, number>;
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
  since: {},
  error: null,
  setActivity: (userId, activity) => set((s) => {
    const activities = { ...s.activities };
    const since = { ...s.since };
    if (activity) { activities[userId] = activity; since[userId] = Date.now(); } else { delete activities[userId]; delete since[userId]; }
    return { activities, since };
  }),
}));

/**
 * Where the song is now, in ms: the position the sender reported, moved on by the time since it arrived here.
 * Undefined when the sender didn't report a position. Capped at the length of the song.
 */
export function listenPosition(activity: Activity, since: number | undefined, now: number): number | undefined {
  if (activity.progressMs === undefined) return undefined;
  const pos = activity.progressMs + (since === undefined ? 0 : Math.max(0, now - since));
  return activity.durationMs ? Math.min(pos, activity.durationMs) : pos;
}

const bridge = () => (typeof window !== 'undefined' ? window.chatward?.spotify : undefined);

/** What we last told the server, and when, so an unchanged song isn't sent again every poll. */
let sent: Activity | null = null;
let sentAt = 0;

const sameSong = (a: Activity, b: Activity) =>
  a.title === b.title && a.artist === b.artist && a.url === b.url && a.coverUrl === b.coverUrl && a.durationMs === b.durationMs;

/** Send when the song changed, or when the position jumped (a skip or scrub). Normal playback is not sent again. */
function shouldSend(activity: Activity | null): boolean {
  if (!activity || !sent) return activity !== sent;
  if (!sameSong(activity, sent)) return true;
  if (activity.progressMs === undefined || sent.progressMs === undefined) return false;
  const expected = sent.progressMs + (Date.now() - sentAt);
  return Math.abs(activity.progressMs - expected) > SEEK_MS;
}

function publish(activity: Activity | null) {
  const me = useSession.getState().user?.id;
  if (me) useSpotify.getState().setActivity(me, activity);
  if (!shouldSend(activity)) return;
  sent = activity;
  sentAt = Date.now();
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
      useSpotify.setState({ activities: {}, since: {} });
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
    useSpotify.setState({ activities: {}, since: {} });
  };
}
