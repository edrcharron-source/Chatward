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

type SignOutHook = () => void | Promise<void>;
const signOutHooks: SignOutHook[] = [];

/** Cleanup that must run while the token is still set, such as leaving a call on the server. */
export function onBeforeSignOut(hook: SignOutHook) { signOutHooks.push(hook); }

/** Logs out. Hooks run first, so their server calls still go out as this user. Then the session is cleared. */
export async function signOut() {
  for (const hook of signOutHooks) {
    try { await hook(); } catch { /* cleanup is best effort; logging out must still finish */ }
  }
  useSession.getState().logout();
}

const LS = 'chatward.session';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();

export const useSession = create<SessionState>((set, get) => ({
  serverUrl: saved.serverUrl ?? 'http://localhost:3000',
  token: saved.token ?? null,
  user: saved.user ?? null,
  servers: [], activeServerId: null, activeChannelId: null,
  presence: {}, myStatus: 'online', voiceOccupants: {}, unread: {},
  setServerUrl: (serverUrl) => { set({ serverUrl }); persist(); },
  setAuth: (token, user) => { set({ token, user }); persist(); },
  setUser: (user) => { set({ user }); persist(); },
  logout: () => { set({ token: null, user: null, servers: [], activeServerId: null, activeChannelId: null, myStatus: 'online', voiceOccupants: {}, unread: {} }); persist(); },
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
export async function refreshUnread() {
  const { unread } = await api.get<{ unread: Record<string, number> }>('/api/unread');
  const st = useSession.getState();
  st.setUnread(unread);
  // The channel on screen is being read, so it stays clear even if the server counted a message that just arrived.
  if (st.activeChannelId && !document.hidden) st.clearUnread(st.activeChannelId);
}

function persist() {
  const { serverUrl, token, user } = useSession.getState();
  localStorage.setItem(LS, JSON.stringify({ serverUrl, token, user }));
}
