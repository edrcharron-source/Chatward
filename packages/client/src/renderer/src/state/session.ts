import { create } from 'zustand';
import type { Channel, Member, Server, User } from '@chatward/shared';

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
  setActive: (serverId: string | null, channelId: string | null) => void;
  setPresence: (userId: string, s: SessionState['presence'][string]) => void;
  setVoiceOccupants: (channelId: string, userIds: string[]) => void;
  bumpUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
}

const LS = 'chatward.session';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();

export const useSession = create<SessionState>((set, get) => ({
  serverUrl: saved.serverUrl ?? 'http://localhost:3000',
  token: saved.token ?? null,
  user: saved.user ?? null,
  servers: [], activeServerId: null, activeChannelId: null,
  presence: {}, voiceOccupants: {}, unread: {},
  setServerUrl: (serverUrl) => { set({ serverUrl }); persist(); },
  setAuth: (token, user) => { set({ token, user }); persist(); },
  setUser: (user) => { set({ user }); persist(); },
  logout: () => { set({ token: null, user: null, servers: [], activeServerId: null, activeChannelId: null, voiceOccupants: {}, unread: {} }); persist(); },
  setServers: (servers) => {
    const s = get();
    const active = servers.find((x) => x.server.id === s.activeServerId) ?? servers[0];
    set({ servers, activeServerId: active?.server.id ?? null,
      activeChannelId: s.activeChannelId && active?.channels.some((c) => c.id === s.activeChannelId) ? s.activeChannelId : active?.channels.find((c) => c.kind === 'text')?.id ?? null });
  },
  upsertServer: (b) => set((s) => ({ servers: s.servers.some((x) => x.server.id === b.server.id) ? s.servers.map((x) => (x.server.id === b.server.id ? b : x)) : [...s.servers, b] })),
  setActive: (activeServerId, activeChannelId) => set({ activeServerId, activeChannelId }),
  setPresence: (id, st) => set((s) => ({ presence: { ...s.presence, [id]: st } })),
  setVoiceOccupants: (ch, ids) => set((s) => ({ voiceOccupants: { ...s.voiceOccupants, [ch]: ids } })),
  bumpUnread: (ch) => set((s) => ({ unread: { ...s.unread, [ch]: (s.unread[ch] ?? 0) + 1 } })),
  clearUnread: (ch) => set((s) => { const u = { ...s.unread }; delete u[ch]; return { unread: u }; }),
}));

function persist() {
  const { serverUrl, token, user } = useSession.getState();
  localStorage.setItem(LS, JSON.stringify({ serverUrl, token, user }));
}
