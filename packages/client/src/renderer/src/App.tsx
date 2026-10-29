import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { Channel, Member } from '@chatward/shared';
import { api, ApiError } from './api/http';
import { connectWs, disconnectWs, onFrame, sendFrame } from './api/ws';
import { keepTokenFresh } from './api/token';
import { isLiveChannel, refreshUnread, signOut, useSession, type ServerBundle } from './state/session';
import { useSettings, applyTheme } from './state/settings';
import { applySkin } from './skins';
import { useVoice, rekeyActiveCall, resumeVoiceSlot, clearLeftoverVoiceSlot, leaveCallOnExit } from './state/voice';
import { forgetChatChannels, useChat } from './state/chat';
import { accountKey, adoptLegacyIfOwned, initDevice, syncChannelKeys, handleEnvelope, handleMemberLeave, forgetChannels } from './crypto';
import { installNotifications } from './notify/notify';
import AuthScreen from './components/auth/AuthScreen';
import ServerSidebar from './components/servers/ServerSidebar';
import ChannelList from './components/servers/ChannelList';
import MemberList from './components/servers/MemberList';
import ChatView from './components/chat/ChatView';
import VoiceChannelView from './components/voice/VoiceChannelView';
import TheaterSplit from './components/voice/TheaterSplit';
import { WatchPartyPanel } from './components/watchparty';
import SettingsModal from './components/settings/SettingsModal';
import TestConsole from './components/testconsole/TestConsole';
import DemoBanner from './demo/DemoBanner';
import UpdateBanner from './components/updates/UpdateBanner';
import DeviceAlertBanner from './components/devices/DeviceAlertBanner';
import { showDeviceAlert } from './state/deviceAlerts';
import UpdateRequired from './components/updates/UpdateRequired';
import type { MainBarId } from './layout/manifest';
import { gridStyle, useLayout } from './layout/useLayout';
import PoweredBy from './components/brand/PoweredBy';
import { checkServerVersion, useUpdates } from './state/updates';

export function App() {
  const token = useSession((s) => s.token);
  const serverUrl = useSession((s) => s.serverUrl);
  const server = useUpdates((s) => s.server);
  const theme = useSettings((s) => s.theme);
  const skin = useSettings((s) => s.skin);
  useEffect(() => { void checkServerVersion(serverUrl); }, [serverUrl]);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);
  useEffect(() => { void applySkin(skin); }, [skin]);
  return (
    <div className="cw-app">
      <UpdateBanner />
      <DeviceAlertBanner />
      <DemoBanner />
      <div className="cw-app-body">
        {server.kind === 'update-required'
          ? <UpdateRequired serverUrl={serverUrl} minClientVersion={server.minClientVersion} />
          : token ? <Shell /> : <AuthScreen />}
      </div>
      <PoweredBy />
    </div>
  );
}

// A burst of keypackages.low frames runs one key sync, a few seconds after the first, instead of one sync per frame.
let lowKeyPackageSync: ReturnType<typeof setTimeout> | null = null;
function syncAfterLowKeyPackages(): void {
  if (lowKeyPackageSync) return;
  lowKeyPackageSync = setTimeout(() => {
    lowKeyPackageSync = null;
    void syncChannelKeys(useSession.getState().servers).catch((e) => console.error(e));
  }, 5_000);
}

function Shell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const { servers, activeServerId, activeChannelId } = useSession();
  const bundle = servers.find((s) => s.server.id === activeServerId);
  const channel = bundle?.channels.find((c) => c.id === activeChannelId);
  const voiceChannelId = useVoice((s) => s.channelId);
  // A watch party belongs to the call: the server keeps one snapshot per voice channel and only people in it can change it.
  const callServer = servers.find((b) => b.channels.some((c) => c.id === voiceChannelId));
  const watchKeyChannelId = callServer?.channels.find((c) => c.kind === 'text')?.id;
  const theaterKey = useVoice((s) => s.theaterKey);
  const setTheater = useVoice((s) => s.setTheater);
  // the text chat shown below the share in theater mode; follows the last text channel opened
  const [chatChannelId, setChatChannelId] = useState<string | null>(null);
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(false);
  const layout = useLayout();
  const openTextId = channel?.kind === 'text' ? channel.id : undefined;
  useEffect(() => {
    if (openTextId) setChatChannelId(openTextId);
  }, [openTextId]);
  useEffect(() => {
    if (!theaterKey) {
      setSidebarsCollapsed(false);
      return;
    }
    // Esc leaves theater mode unless the browser is handling it as a fullscreen exit
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setTheater(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [theaterKey, setTheater]);

  // theater mode keeps the call's share on top and a text chat below, so the chat stays usable while a share is featured
  const callChannel = bundle?.channels.find((c) => c.id === voiceChannelId);
  const textChannels = bundle?.channels.filter((c) => c.kind === 'text') ?? [];
  const chatChannel = channel?.kind === 'text' ? channel : textChannels.find((c) => c.id === chatChannelId) ?? textChannels[0];
  const theaterWithChat = theaterKey !== null && callChannel !== undefined && chatChannel !== undefined;
  const hideSidebars = theaterKey !== null && sidebarsCollapsed;
  // The chat under the share is on screen, so its new messages should not count as unread.
  const theaterChatId = theaterWithChat && chatChannel ? chatChannel.id : null;
  useEffect(() => {
    useSession.getState().setTheaterChatId(theaterChatId);
    return () => useSession.getState().setTheaterChatId(null);
  }, [theaterChatId]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let stopNotify: (() => void) | undefined;
    let stopTokenCheck: (() => void) | undefined;
    let seenReady = false;
    let active = true;
    // Each reconnect starts its own refresh. An older refresh that is still retrying gives up once a newer one starts.
    let refreshRun = 0;
    (async () => {
      const { serverUrl, user } = useSession.getState();
      await initDevice(accountKey(serverUrl, user?.username ?? ''));
      await adoptLegacyIfOwned();
      await loadServersUntilReachable(() => active);
      if (!active) return;
      connectWs();
      stopTokenCheck = keepTokenFresh();
      stopNotify = installNotifications();
      off = onFrame((f) => {
        const st = useSession.getState();
        switch (f.t) {
          case 'ready': {
            // Every (re)connect: rebuild what may have changed while the socket was down.
            st.setUser(f.user);
            // The server counts every new connection as online, so put back the status we picked.
            const mine = st.myStatus;
            useSession.setState({ presence: { ...f.presence, [f.user.id]: mine } });
            if (mine !== 'online') sendFrame({ t: 'presence', status: mine });
            if (seenReady) {
              const run = ++refreshRun;
              const stillWanted = () => active && run === refreshRun;
              retryWithBackoff(() => loadServers(stillWanted), stillWanted)
                .catch((e) => console.error('Could not refresh after reconnect', e));
              resumeVoiceSlot();
            } else {
              clearLeftoverVoiceSlot();
            }
            seenReady = true;
            break;
          }
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
          case 'channel.update': {
            const b = st.servers.find((x) => x.server.id === f.channel.serverId);
            if (b) st.upsertServer({ ...b, channels: b.channels.map((c) => (c.id === f.channel.id ? f.channel : c)) });
            break;
          }
          case 'channel.delete': {
            // leave the call if it was in the deleted voice channel, since the server has already dropped everyone
            if (useVoice.getState().channelId === f.channelId) void useVoice.getState().leave();
            st.removeChannel(f.serverId, f.channelId);
            forgetChatChannels([f.channelId]);
            void forgetChannels([f.channelId]).catch((e) => console.error(e));
            // Calls key off the server's first text channel. Deleting that one moves them to the next channel's key.
            // No epoch moves here, so the call is rekeyed explicitly.
            void syncChannelKeys(useSession.getState().servers).then(rekeyActiveCall).catch((e) => console.error(e));
            break;
          }
          case 'server.update': {
            const b = st.servers.find((x) => x.server.id === f.server.id);
            if (b) st.upsertServer({ ...b, server: f.server });
            break;
          }
          case 'server.delete': {
            // the server has already dropped every voice slot, so end our own call in it too
            if (useVoice.getState().serverId === f.serverId) void useVoice.getState().leave();
            const channelIds = st.servers.find((b) => b.server.id === f.serverId)?.channels.map((c) => c.id) ?? [];
            st.removeServer(f.serverId);
            forgetChatChannels(channelIds);
            void forgetChannels(channelIds).catch((e) => console.error(e));
            // A sync still running or retrying for this server must not keep using its channels.
            void syncChannelKeys(useSession.getState().servers).catch((e) => console.error(e));
            break;
          }
          case 'member.role': {
            const b = st.servers.find((x) => x.server.id === f.serverId);
            if (b) st.upsertServer({ ...b, members: b.members.map((m) => (m.user.id === f.userId ? { ...m, role: f.role } : m)) });
            break;
          }
          case 'member.join': {
            const b = st.servers.find((x) => x.server.id === f.serverId);
            if (b) {
              st.upsertServer({ ...b, members: [...b.members.filter((m) => m.user.id !== f.member.user.id), f.member] });
              void syncChannelKeys(useSession.getState().servers);
            } else if (f.member.user.id === st.user?.id) {
              // This device has not seen the server yet (created or joined on another device), so fetch the list.
              void loadServers();
            }
            break;
          }
          case 'voice.kicked': {
            // only the call they are in matters; a kick for another channel is stale or already left
            if (useVoice.getState().channelId !== f.channelId) break;
            void useVoice.getState().leave()
              .then(() => useVoice.setState({ notice: 'An admin removed you from the call' }))
              .catch((e) => console.error(e));
            break;
          }
          case 'voice.moved': {
            // the account joined a call on another device; if this device is still in that call, hang up quietly
            if (useVoice.getState().channelId !== f.channelId) break;
            void useVoice.getState().leave()
              .then(() => useVoice.setState({ notice: 'This account joined the call from another device' }))
              .catch((e) => console.error(e));
            break;
          }
          case 'member.leave': {
            if (f.userId === st.user?.id) {
              // we left (or were kicked), so end any call we had in this server
              if (useVoice.getState().serverId === f.serverId) void useVoice.getState().leave();
              // Our channel groups stay: if nobody is online to commit the Remove, a rejoin must still find them
              const channelIds = st.servers.find((b) => b.server.id === f.serverId)?.channels.map((c) => c.id) ?? [];
              st.removeServer(f.serverId);
              forgetChatChannels(channelIds);
              void syncChannelKeys(useSession.getState().servers).catch((e) => console.error(e));
              break;
            }
            const b = st.servers.find((x) => x.server.id === f.serverId);
            if (b) st.upsertServer({ ...b, members: b.members.filter((m) => m.user.id !== f.userId) });
            void handleMemberLeave(f.serverId, f.userId, useSession.getState().servers)
              .catch((e) => console.error(e));
            break;
          }
          case 'member.devices': {
            st.setServers(st.servers.map((b) => b.server.id !== f.serverId ? b
              : { ...b, members: b.members.map((m) => (m.user.id === f.userId ? { ...m, devices: f.devices } : m)) }));
            void syncChannelKeys(useSession.getState().servers);
            break;
          }
          // Another device moved a group on, so catch up now. A call follows the new epoch as the sync applies it.
          // A low key-package pool is topped up the same way, rather than waiting for the next full sync.
          case 'group.commit':
          case 'group.welcome':
            void syncChannelKeys(useSession.getState().servers).catch((e) => console.error(e));
            break;
          case 'keypackages.low': syncAfterLowKeyPackages(); break;
          case 'key.envelope': void handleEnvelope(f.envelope); break;
          case 'device.added':
            // Flash the taskbar so a background window still gets noticed.
            if (!document.hasFocus()) window.chatward?.flashWindow();
            showDeviceAlert({ deviceId: f.deviceId, createdAt: f.createdAt });
            break;
        }
      });
      setReady(true);
    })().catch((e) => console.error(e));
    window.addEventListener('pagehide', leaveCallOnExit);
    return () => { active = false; off?.(); stopNotify?.(); stopTokenCheck?.(); disconnectWs(); window.removeEventListener('pagehide', leaveCallOnExit); };
  }, []);

  /** A reconnect refresh passes stillWanted: once a newer refresh has started, this answer may be older, so it is dropped. */
  async function loadServers(stillWanted: () => boolean = () => true) {
    const { servers } = await api.get<{ servers: ServerBundle[] }>('/api/servers');
    if (!stillWanted()) return;
    useSession.getState().setServers(servers);
    // Channels removed while we were offline are missing from the new list, so their cached chat is dropped here.
    forgetChatChannels(Object.keys(useChat.getState().channels).filter((id) => !isLiveChannel(id)));
    void refreshUnread().catch(() => {});
    for (const b of servers) {
      const { channels } = await api.get<{ channels: Record<string, string[]> }>(`/api/servers/${b.server.id}/voice-state`);
      if (!stillWanted()) return;
      for (const [cid, ids] of Object.entries(channels)) useSession.getState().setVoiceOccupants(cid, ids);
    }
    await syncChannelKeys(servers);
  }

  /** Runs a load again with growing waits until it succeeds. A 401 means the session is gone, so it is rethrown and signs out. */
  async function retryWithBackoff(load: () => Promise<void>, stillWanted: () => boolean, onFailure?: () => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        await load();
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw e;
        console.error('Could not load servers, retrying', e);
        onFailure?.();
        await new Promise((resolve) => setTimeout(resolve, Math.min(15000, 1000 * 2 ** attempt)));
        if (!stillWanted()) return;
      }
    }
  }

  /** Retries the startup load until the server answers, showing the unreachable screen meanwhile. */
  function loadServersUntilReachable(stillActive: () => boolean) {
    return retryWithBackoff(
      async () => {
        await loadServers();
        setUnreachable(false);
      },
      stillActive,
      () => setUnreachable(true),
    );
  }

  // Ctrl+Shift+T opens the feature test console from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); setTestOpen((o) => !o); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return (
      <div className="cw-shell-loading">
        {unreachable ? (
          <>
            <div className="muted">Can't reach server, retrying…</div>
            <button type="button" className="danger" onClick={() => void signOut()}>Log out</button>
          </>
        ) : <div className="muted">Loading…</div>}
      </div>
    );
  }
  // Main-bar actions by id. The order comes from the active layout; each button's condition lives here.
  const mainBarActions: Record<MainBarId, ReactNode> = {
    sidebars: theaterKey !== null && (
      <button className="icon" onClick={() => setSidebarsCollapsed((c) => !c)} aria-pressed={sidebarsCollapsed}>
        {sidebarsCollapsed ? 'Show sidebars' : 'Hide sidebars'}
      </button>
    ),
    test: <button className="icon" onClick={() => setTestOpen(true)} title="Feature test console (Ctrl+Shift+T)">🧪 Test</button>,
    watch: channel && (
      <button className="icon" onClick={() => setWatchOpen((o) => !o)} aria-pressed={watchOpen} title="Watch YouTube together">
        🎬 {watchOpen ? 'Close watch party' : 'Watch together'}
      </button>
    ),
  };
  return (
    <div className="cw-shell" data-region="shell" style={gridStyle(layout)}>
      <ServerSidebar onReload={loadServers} />
      {!hideSidebars && <ChannelList onOpenSettings={() => setSettingsOpen(true)} onReload={loadServers} />}
      <main className="cw-main" data-region="main">
        {testOpen ? <TestConsole onClose={() => setTestOpen(false)} /> : <>
          {channel && (
            <div className="cw-main-bar" data-region="main-bar">
              {layout.mainBar.map((id) => <Fragment key={id}>{mainBarActions[id]}</Fragment>)}
            </div>
          )}
        {/* Voice channels have no message key of their own, so their watch party rides the server's first text channel. */}
        {watchOpen && (voiceChannelId && watchKeyChannelId
          ? <WatchPartyPanel key={`watch-${voiceChannelId}`} callChannelId={voiceChannelId} keyChannelId={watchKeyChannelId} />
          : <div className="cw-main-note muted">Join a voice channel to start a watch party.</div>)}
        {theaterWithChat && callChannel && chatChannel
          ? (
            <TheaterSplit
              top={<VoiceChannelView key={callChannel.id} channel={callChannel} theaterOnly />}
              bottom={(
                <>
                  {channel?.kind === 'voice' && (
                    <div className="cw-chat-picker">
                      <span className="muted">Chat</span>
                      <select value={chatChannel.id} onChange={(e) => setChatChannelId(e.target.value)} aria-label="Text channel for chat">
                        {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="cw-fill">
                    <ChatView key={chatChannel.id} channel={chatChannel} />
                  </div>
                </>
              )}
            />
          )
          : channel?.kind === 'voice'
            ? <VoiceChannelView key={channel.id} channel={channel} />
            : channel
              ? <ChatView key={channel.id} channel={channel} />
              : <div className="cw-main-empty muted">{bundle ? 'Select a channel' : 'Create or join a server to get started'}</div>}
        </>}
      </main>
      {bundle && !hideSidebars && <MemberList serverId={bundle.server.id} members={bundle.members as Member[]} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {/* keep voice room mounted even when browsing text channels */}
      {voiceChannelId && null}
    </div>
  );
}
export type { Channel };
