import { create } from 'zustand';
import type { Channel, Member, Server, User } from '@chatward/shared';
import { api } from '../api/http';

export interface ServerBundle { server: Server; channels: Channel[]; members: Member[] }

interface SessionState {
  serverUrl: string;
  token: string | null;
  user: User | null;
  servers: ServerBundle[];
  activeServerId: string | null;
  activeChannelId: string | null;
  /** userId -> presence */
  presence: Record<string, 'online' | 'idle' | 'dnd' | 'offline'>;
  /** The status this user picked for themselves. Kept for this run only; a restart starts back at online. */
  myStatus: 'online' | 'idle' | 'dnd';
  /** channelId -> userIds currently in that voice channel */
  voiceOccupants: Record<string, string[]>;
  /** channelId -> unread count (text) */
  unread: Record<string, number>;
  /** The text chat shown under a featured screen share in theater mode, or null. Read on screen, so it counts as visible. */
  theaterChatId: string | null;
  setTheaterChatId: (channelId: string | null) => void;
  setServerUrl: (u: string) => void;
  setAuth: (token: string, user: User) => void;
  setUser: (u: User) => void;
  logout: () => void;
  setServers: (s: ServerBundle[]) => void;
  upsertServer: (b: ServerBundle) => void;
  /** Drops a server we are no longer in. Moves the view off it if it was open. */
  removeServer: (serverId: string) => void;
  /** Drops a channel. Moves the view to the server's first text channel if it was open. */
  removeChannel: (serverId: string, channelId: string) => void;
  setActive: (serverId: string | null, channelId: string | null) => void;
  setPresence: (userId: string, s: SessionState['presence'][string]) => void;
  setMyStatus: (status: SessionState['myStatus']) => void;
  setVoiceOccupants: (channelId: string, userIds: string[]) => void;
  bumpUnread: (channelId: string) => void;
  /** Replaces the unread counts with the server's. */
  setUnread: (unread: Record<string, number>) => void;
  clearUnread: (channelId: string) => void;
}

export interface SignOutOptions {
  /** False after the account is deleted: the token no longer works, so hooks must skip server calls. */
  serverAvailable?: boolean;
}

type SignOutHook = (opts: { serverAvailable: boolean }) => void | Promise<void>;
const signOutHooks: SignOutHook[] = [];

/** Cleanup that must run before the session is cleared. Hooks get `serverAvailable` so they know whether they may call the server. */
export function onBeforeSignOut(hook: SignOutHook) { signOutHooks.push(hook); }

/** Logs out. Hooks run first, so their server calls still go out as this user. Then the session is cleared. */
export async function signOut({ serverAvailable = true }: SignOutOptions = {}) {
  for (const hook of signOutHooks) {
    try { await hook({ serverAvailable }); } catch { /* cleanup is best effort; logging out must still finish */ }
  }
  useSession.getState().logout();
}

const LS = 'chatward.session';
// The login token is a secret, so it is kept in secureStore (encrypted by the OS). Only the server address and the user stay in localStorage.
const TOKEN_STORE = 'session.token';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();
// A token saved to localStorage by an older build. Moved into secureStore by restoreSession.
let legacyToken: string | null = typeof saved.token === 'string' ? saved.token : null;

export const useSession = create<SessionState>((set, get) => ({
  serverUrl: saved.serverUrl ?? 'http://localhost:3000',
  token: null,
  user: saved.user ?? null,
  servers: [], activeServerId: null, activeChannelId: null,
  presence: {}, myStatus: 'online', voiceOccupants: {}, unread: {}, theaterChatId: null,
  setTheaterChatId: (theaterChatId) => set({ theaterChatId }),
  setServerUrl: (serverUrl) => { set({ serverUrl }); persist(); },
  setAuth: (token, user) => { set({ token, user }); persist(); saveToken(token); },
  setUser: (user) => { set({ user }); persist(); },
  logout: () => { set({ token: null, user: null, servers: [], activeServerId: null, activeChannelId: null, myStatus: 'online', voiceOccupants: {}, unread: {} }); persist(); saveToken(null); },
  setServers: (servers) => {
    const s = get();
    const active = servers.find((x) => x.server.id === s.activeServerId) ?? servers[0];
    set({ servers, activeServerId: active?.server.id ?? null,
      activeChannelId: s.activeChannelId && active?.channels.some((c) => c.id === s.activeChannelId) ? s.activeChannelId : active?.channels.find((c) => c.kind === 'text')?.id ?? null });
  },
  upsertServer: (b) => set((s) => ({ servers: s.servers.some((x) => x.server.id === b.server.id) ? s.servers.map((x) => (x.server.id === b.server.id ? b : x)) : [...s.servers, b] })),
  removeServer: (serverId) => set((s) => {
    const servers = s.servers.filter((b) => b.server.id !== serverId);
    if (s.activeServerId !== serverId) return { servers };
    const next = servers[0];
    return { servers, activeServerId: next?.server.id ?? null, activeChannelId: next?.channels.find((c) => c.kind === 'text')?.id ?? null };
  }),
  removeChannel: (serverId, channelId) => set((s) => {
    const servers = s.servers.map((b) => (b.server.id === serverId ? { ...b, channels: b.channels.filter((c) => c.id !== channelId) } : b));
    if (s.activeChannelId !== channelId) return { servers };
    const first = servers.find((b) => b.server.id === serverId)?.channels.find((c) => c.kind === 'text')?.id ?? null;
    return { servers, activeChannelId: first };
  }),
  setActive: (activeServerId, activeChannelId) => set({ activeServerId, activeChannelId }),
  setPresence: (id, st) => set((s) => ({ presence: { ...s.presence, [id]: st } })),
  setMyStatus: (myStatus) => set((s) => ({ myStatus, presence: s.user ? { ...s.presence, [s.user.id]: myStatus } : s.presence })),
  setVoiceOccupants: (ch, ids) => set((s) => ({ voiceOccupants: { ...s.voiceOccupants, [ch]: ids } })),
  bumpUnread: (ch) => set((s) => ({ unread: { ...s.unread, [ch]: (s.unread[ch] ?? 0) + 1 } })),
  setUnread: (unread) => set({ unread }),
  clearUnread: (ch) => {
    set((s) => { const u = { ...s.unread }; delete u[ch]; return { unread: u }; });
    // Saved on the server too, so the channel stays read after a restart or on another launch.
    api.post(`/api/channels/${ch}/read`).catch(() => { /* offline: the next read saves it */ });
  },
}));

/** Pulls unread counts from the server. Covers messages that arrived while the app was closed or disconnected. */
/** True while the account's server list still holds the channel. A removed, left or deleted channel is not live. */
export function isLiveChannel(channelId: string): boolean {
  return useSession.getState().servers.some((b) => b.channels.some((c) => c.id === channelId));
}

export async function refreshUnread() {
  const { unread } = await api.get<{ unread: Record<string, number> }>('/api/unread');
  const st = useSession.getState();
  st.setUnread(unread);
  // The channel on screen is being read, so it stays clear even if the server counted a message that just arrived.
  // Theater mode shows a voice channel's chat beside the video, so that chat counts as on screen too.
  if (!document.hidden) {
    for (const ch of new Set([st.activeChannelId, st.theaterChatId])) {
      if (ch) st.clearUnread(ch);
    }
  }
}

/** Loads the login token from secureStore. Call once before the app renders, since requests read the token synchronously. Moves a token left in localStorage by an older build into secureStore. */
export async function restoreSession(): Promise<void> {
  const store = window.chatward.secureStore;
  try {
    if (legacyToken) {
      const token = legacyToken;
      await store.set(TOKEN_STORE, token);
      legacyToken = null;
      useSession.setState({ token });
      persist(); // Rewrites localStorage without the token.
      return;
    }
    const token = await store.get(TOKEN_STORE);
    if (token) useSession.setState({ token });
  } catch { /* secureStore unreadable: the user signs in again */ }
}

function persist() {
  const { serverUrl, user } = useSession.getState();
  localStorage.setItem(LS, JSON.stringify({ serverUrl, user }));
}

function saveToken(token: string | null) {
  window.chatward.secureStore.set(TOKEN_STORE, token ?? '').catch(() => { /* the next sign-in saves it again */ });
}
