import { useEffect, useState } from 'react';
import type { Channel, Member } from '@chatward/shared';
import { api } from './api/http';
import { connectWs, disconnectWs, onFrame } from './api/ws';
import { useSession, type ServerBundle } from './state/session';
import { useSettings, applyTheme } from './state/settings';
import { useVoice } from './state/voice';
import { initDevice, syncChannelKeys, handleEnvelope } from './crypto';
import { installNotifications } from './notify/notify';
import AuthScreen from './components/auth/AuthScreen';
import ServerSidebar from './components/servers/ServerSidebar';
import ChannelList from './components/servers/ChannelList';
import MemberList from './components/servers/MemberList';
import ChatView from './components/chat/ChatView';
import VoiceChannelView from './components/voice/VoiceChannelView';
import SettingsModal from './components/settings/SettingsModal';

export function App() {
  const token = useSession((s) => s.token);
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);
  return token ? <Shell /> : <AuthScreen />;
}

function Shell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const { servers, activeServerId, activeChannelId } = useSession();
  const bundle = servers.find((s) => s.server.id === activeServerId);
  const channel = bundle?.channels.find((c) => c.id === activeChannelId);
  const voiceChannelId = useVoice((s) => s.channelId);

  useEffect(() => {
    let off: (() => void) | undefined;
    let stopNotify: (() => void) | undefined;
    (async () => {
      await initDevice();
      await loadServers();
      connectWs();
      stopNotify = installNotifications();
      off = onFrame((f) => {
        const st = useSession.getState();
        switch (f.t) {
          case 'presence': st.setPresence(f.userId, f.status); break;
          case 'voice.state': st.setVoiceOccupants(f.channelId, f.userIds); break;
          case 'user.update': {
            if (f.user.id === st.user?.id) st.setUser(f.user);
            st.setServers(st.servers.map((b) => ({ ...b, members: b.members.map((m) => (m.user.id === f.user.id ? { ...m, user: f.user } : m)) })));
            break;
          }
          case 'channel.new': {
            const b = st.servers.find((x) => x.server.id === f.channel.serverId);
            if (b) st.upsertServer({ ...b, channels: [...b.channels, f.channel] });
            void syncChannelKeys(useSession.getState().servers);
            break;
          }
          case 'member.join': {
            const b = st.servers.find((x) => x.server.id === f.serverId);
            if (b) st.upsertServer({ ...b, members: [...b.members.filter((m) => m.user.id !== f.member.user.id), f.member] });
            void syncChannelKeys(useSession.getState().servers);
            break;
          }
          case 'member.devices': {
            st.setServers(st.servers.map((b) => b.server.id !== f.serverId ? b
              : { ...b, members: b.members.map((m) => (m.user.id === f.userId ? { ...m, devices: f.devices } : m)) }));
            void syncChannelKeys(useSession.getState().servers);
            break;
          }
          case 'key.envelope': void handleEnvelope(f.envelope); break;
        }
      });
      setReady(true);
    })().catch((e) => console.error(e));
    return () => { off?.(); stopNotify?.(); disconnectWs(); };
  }, []);

  async function loadServers() {
    const { servers } = await api.get<{ servers: ServerBundle[] }>('/api/servers');
    useSession.getState().setServers(servers);
    for (const b of servers) {
      const { channels } = await api.get<{ channels: Record<string, string[]> }>(`/api/servers/${b.server.id}/voice-state`);
      for (const [cid, ids] of Object.entries(channels)) useSession.getState().setVoiceOccupants(cid, ids);
    }
    await syncChannelKeys(servers);
  }

  if (!ready) return <div style={{ display: 'grid', placeItems: 'center', height: '100%' }} className="muted">Loading…</div>;
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ServerSidebar onReload={loadServers} />
      <ChannelList onOpenSettings={() => setSettingsOpen(true)} onReload={loadServers} />
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {channel?.kind === 'voice'
          ? <VoiceChannelView key={channel.id} channel={channel} />
          : channel
            ? <ChatView key={channel.id} channel={channel} />
            : <div style={{ margin: 'auto' }} className="muted">{bundle ? 'Select a channel' : 'Create or join a server to get started'}</div>}
      </main>
      {bundle && <MemberList members={bundle.members as Member[]} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {/* keep voice room mounted even when browsing text channels */}
      {voiceChannelId && null}
    </div>
  );
}
export type { Channel };
