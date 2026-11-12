import '../float/float.css';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Member } from '@chatward/shared';
import { useSession, type ServerBundle } from '../../state/session';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import ChatView from '../chat/ChatView';
import VoiceChannelView, { VideoView, type Feed } from '../voice/VoiceChannelView';
import { useScreenShare } from '../voice/useScreenShare';
import { useFloatingBox } from '../float/useFloatingBox';
import VoiceDock from '../voice/VoiceDock';
import VaultView from '../vault/VaultView';
import WorkoutsView from '../workouts/WorkoutsView';
import { WatchPartyPanel } from '../watchparty';
import MemberList from '../servers/MemberList';
import StatusPicker from '../servers/StatusPicker';
import ServerSettingsDialog from '../servers/ServerSettingsDialog';
import Avatar from '../servers/Avatar';
import WelcomeCard from '../welcome/WelcomeCard';
import type { SettingsTabId } from '../settings/SettingsModal';
import { isAdmin } from '../servers/util';
import PixelIcon, { type PixelIconName } from '../icons/PixelIcon';
import { PopoutWindow } from './PopoutWindow';
import LcarsLayout from '../lcars/LcarsLayout';
import { OrbitBackdrop, OrbitMark, OrbitWindowButtons } from '../orbit/OrbitFrame';
import MysteryButton from '../mystery/MysteryButton';
import { usePhone } from '../../web/usePhone';
import { clearNotifications, syncPush } from '../../web/push';
import MeSheet from '../phone/MeSheet';
import { NotifyPrompt } from '../phone/Notifications';
import './tabs.css';
import './phone.css';

export type TabId = 'text' | 'voice' | 'watch' | 'vault' | 'workouts';

// `short` is the name under the icon on the phone's bottom bar, where five tabs share the width.
const TABS: Array<{ id: TabId; label: string; short?: string; icon: PixelIconName }> = [
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'watch', label: 'Watch together', short: 'Watch', icon: 'watch' },
  { id: 'vault', label: 'Vault', icon: 'vault' },
  { id: 'workouts', label: 'Workouts', icon: 'crown' },
];

/** A tab named in the address (?tab=workouts), which notifications open the app with. */
function tabFromUrl(url: string): TabId | null {
  try {
    const t = new URL(url, location.href).searchParams.get('tab');
    return TABS.some((x) => x.id === t) ? (t as TabId) : null;
  } catch { return null; }
}

/** The tabs in the order the user dragged them into. */
function orderTabs(saved: unknown): typeof TABS {
  const ids = Array.isArray(saved) ? saved : [];
  const known = ids.map((id) => TABS.find((t) => t.id === id)).filter((t): t is (typeof TABS)[number] => !!t);
  const unique = known.filter((t, i) => known.indexOf(t) === i);
  return [...unique, ...TABS.filter((t) => !unique.includes(t))];
}

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
/** In the split view the text chat never gets narrower than this, so there is room to read and type. */
const TEXT_MIN = 'min(380px, 60%)';
const clampSplit = (r: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, r));

/**
 * The tabs layout: no channel sidebar. The server's first text channel and first voice channel are its one text chat and
 * one voice chat, reached by the tab bar along with the watch party and the vault. Text and voice can sit side by side,
 * and any tab can be popped out into its own window.
 *
 * `frame="lcars"` draws the same tabs, panes and controls inside the LCARS frame (components/lcars) instead: the tabs
 * run down a left rail, the window buttons sit in the top bar and the call controls in the bottom bar.
 *
 * `frame="orbit"` keeps this layout's places for everything and dresses it as the Orbit frame (components/orbit): a line
 * drawing behind the panes, an emblem before the server's name, and the window buttons at the end of the tab bar, which
 * becomes the window's title bar.
 *
 * `rail` (the Classic layout) puts the tab bar down the left side instead of along the top, with room to name every
 * button. Orbit, LCARS and phones keep their own bars.
 */
export default function TabsLayout({ bundle, onOpenSettings, onReload, onOpenMovies, frame, rail: railLayout = false }: {
  bundle: ServerBundle | undefined;
  /** opens Settings, on the given tab or the first one */
  onOpenSettings: (tab?: SettingsTabId) => void;
  onReload: () => Promise<void>;
  onOpenMovies: (() => void) | null;
  frame?: 'lcars' | 'orbit';
  rail?: boolean;
}) {
  const user = useSession((s) => s.user);
  const myStatus = useSession((s) => s.myStatus);
  const unread = useSession((s) => s.unread);
  const callChannelId = useVoice((s) => s.channelId);
  const theaterKey = useVoice((s) => s.theaterKey);
  const join = useVoice((s) => s.join);
  // the last two tabs picked, newest first: the open tab is the first, and the split view shows both
  const [recent, setRecent] = useState<[TabId, TabId]>(() => {
    const first = tabFromUrl(location.href);
    return first && first !== 'text' ? [first, 'text'] : ['text', 'voice'];
  });
  // A tapped notification opens its tab (the service worker posts the address when the app is already open).
  useEffect(() => {
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const t = e.data?.type === 'open' ? tabFromUrl(String(e.data.url)) : null;
      if (t) setRecent((r) => (r[0] === t ? r : [t, r[0]]));
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, []);
  const tab = recent[0];
  const [split, setSplit] = useState(false);
  // true while the watch party has something playing, so it can be shown as a corner preview when its tab is left
  const [watchPlaying, setWatchPlaying] = useState(false);
  // true after you leave the watch party while staying in voice; joining a call again puts you back in it
  const [watchLeft, setWatchLeft] = useState(false);
  useEffect(() => { setWatchLeft(false); }, [callChannelId]);
  const leaveWatch = () => { setWatchLeft(true); setWatchPlaying(false); };
  const [popped, setPopped] = useState<TabId[]>([]);
  const [membersHidden, setMembersHidden] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  // Phones: one tab at a time with the tab bar along the bottom, and the member list in a drawer.
  const phone = usePhone();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const presence = useSession((s) => s.presence);
  // The web app: make sure this device's notifications still reach it, and clear the badge once it is open.
  useEffect(() => {
    if (!__CHATWARD_BUILD__.web) return;
    void syncPush().catch((e) => console.warn('[push]', e));
    void clearNotifications();
    const onVisible = () => { if (!document.hidden) void clearNotifications(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => { if (phone) setSplit(false); }, [phone]);
  const savedOrder = useSettings((s) => s.tabOrder);
  const setSettings = useSettings((s) => s.set);
  const tabs = orderTabs(savedOrder);
  const [dragging, setDragging] = useState<TabId | null>(null);
  // where a dragged tab would land: the tab it would go before (null = the end), shown as a marker in the bar
  const [dropBefore, setDropBefore] = useState<TabId | null | undefined>(undefined);
  const tabNav = useRef<HTMLElement>(null);
  // the LCARS rail stacks the tabs top to bottom, so a drop lands above or below a tab rather than left or right of it
  // The Classic layout puts the bar down the left side as a rail, with room to name every button.
  const rail = railLayout && !frame && !phone;
  const vertical = frame === 'lcars' || rail;
  // the split view's two tabs sit in the tab bar's order
  const at = (t: TabId) => tabs.findIndex((x) => x.id === t);
  const [leftTab, rightTab] = at(recent[0]) < at(recent[1]) ? recent : [recent[1], recent[0]];

  /** Moves tab `t` to sit just before `before` (or to the end), and saves the order. */
  const moveTab = (t: TabId, before: TabId | null) => {
    const ids = tabs.map((x) => x.id).filter((id) => id !== t);
    const at = before ? ids.indexOf(before) : -1;
    ids.splice(at < 0 ? ids.length : at, 0, t);
    setSettings({ tabOrder: ids });
  };
  /**
   * The drop spot nearest the pointer, anywhere over the tab bar: the closest tab, then its left or right half.
   * Returns undefined when dropping there would leave the order as it is.
   */
  const dropSpot = (x: number, y: number): TabId | null | undefined => {
    if (!dragging) return undefined;
    let best: { id: TabId; after: boolean; d: number } | null = null;
    for (const el of tabNav.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? []) {
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = vertical ? dx * dx * 4 + dy * dy : dx * dx + dy * dy * 4; // prefer the row the pointer is on when the tabs wrap
      const after = vertical ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
      if (!best || d < best.d) best = { id: el.dataset.tab as TabId, after, d };
    }
    if (!best) return undefined;
    const ids = tabs.map((t) => t.id);
    const before = best.after ? ids[ids.indexOf(best.id) + 1] ?? null : best.id;
    const from = ids.indexOf(dragging);
    // dropping on itself, or just after the tab already in front of it, changes nothing
    if (before === dragging || before === (ids[from + 1] ?? null)) return undefined;
    return before;
  };
  const endDrag = () => { setDragging(null); setDropBefore(undefined); };
  const nudgeTab = (t: TabId, by: -1 | 1) => {
    const ids = tabs.map((x) => x.id);
    const i = ids.indexOf(t);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setSettings({ tabOrder: ids });
  };

  const serverId = bundle?.server.id;
  const text = bundle?.channels.find((c) => c.kind === 'text');
  const voice = bundle?.channels.find((c) => c.kind === 'voice');
  const members = (bundle?.members ?? []) as Member[];
  const me = members.find((m) => m.user.id === user?.id);
  // Server settings only has controls for the owner and admins, so regular members don't get the button
  const canOpenServerSettings = !!bundle && isAdmin(me);
  const isPopped = (t: TabId) => popped.includes(t);
  const textUnread = text ? unread[text.id] ?? 0 : 0;

  const shownTabs = new Set<TabId>(split ? recent : [tab]);
  // The chat counts as read while it is on screen: its tab, one side of the split view, or its own window.
  const textOnScreen = shownTabs.has('text') || isPopped('text');
  const activeId = !shownTabs.has('text') && shownTabs.has('voice') ? voice?.id : text?.id;
  useEffect(() => {
    if (!serverId) return;
    const st = useSession.getState();
    st.setActive(serverId, activeId ?? null);
    st.setTheaterChatId(textOnScreen && text ? text.id : null);
    if (textOnScreen && text) st.clearUnread(text.id);
  }, [serverId, activeId, textOnScreen, text?.id]);
  useEffect(() => () => useSession.getState().setTheaterChatId(null), []);

  const popOut = (t: TabId) => setPopped((p) => (p.includes(t) ? p : [...p, t]));
  const bringBack = (t: TabId) => setPopped((p) => p.filter((x) => x !== t));
  const label = (t: TabId) => TABS.find((x) => x.id === t)?.label ?? t;

  const joinVoice = voice && (() => { void join(voice.serverId, voice.id).catch(() => {}); });

  function pane(t: TabId): ReactNode {
    if (!bundle) return <div className="cw-main-empty muted">Waiting for the server…</div>;
    switch (t) {
      case 'text':
        return text
          ? (
            <div className="cw-tab-pane">
              <WelcomeCard serverName={bundle.server.name}
                onJoinVoice={voice && callChannelId !== voice.id ? () => { selectTab('voice', false); joinVoice?.(); } : undefined}
                onOpenNotifications={() => onOpenSettings('notifications')} />
              <div className="cw-tab-pane"><ChatView key={text.id} channel={text} /></div>
            </div>
          )
          : <Empty>This server has no text chat yet.</Empty>;
      case 'voice':
        if (!voice) return <Empty>This server has no voice chat yet.</Empty>;
        // On a phone the call controls sit under the call, where your thumb is, instead of in a side column.
        return phone
          ? <div className="cw-tab-pane cw-phone-voice"><VoiceChannelView key={voice.id} channel={voice} /><section className="cw-me cw-phone-call" aria-label="Call controls"><VoiceDock stacked /></section></div>
          : <VoiceChannelView key={voice.id} channel={voice} />;
      case 'watch':
        // Watch together belongs to the voice call, so you need to be in voice to be in it. Being in voice puts you in it,
        // but you can leave it (and join it again) without leaving voice.
        // Voice channels have no message key of their own, so the watch party rides the text chat's key.
        if (!callChannelId || !text) {
          return (
            <Empty>
              <p>Join the voice chat to start or join a watch party.</p>
              {joinVoice && <button type="button" className="primary" onClick={joinVoice}>Join voice</button>}
            </Empty>
          );
        }
        return watchLeft
          ? (
            <Empty>
              <p>You left the watch party. You are still in the voice chat.</p>
              <button type="button" className="primary" onClick={() => setWatchLeft(false)}>Join watch together</button>
            </Empty>
          )
          : <div className="cw-tab-scroll"><WatchPartyPanel key={`watch-${callChannelId}`} callChannelId={callChannelId} keyChannelId={text.id} vaultServerId={bundle.server.id} onActiveChange={setWatchPlaying} onLeave={leaveWatch} /></div>;
      case 'workouts':
        return <WorkoutsView />;
      case 'vault':
        return <VaultView key={bundle.server.id} serverId={bundle.server.id} keyChannelId={text?.id} canModerate={isAdmin(me)} people={members.map((m) => ({ id: m.user.id, name: m.user.displayName || m.user.username }))} />;
    }
  }

  // A popped-out tab is drawn in its window only, so its place here says where it went.
  function slot(t: TabId): ReactNode {
    if (!isPopped(t)) return pane(t);
    return (
      <Empty>
        <p>{label(t)} is open in its own window.</p>
        <button type="button" onClick={() => bringBack(t)}>Bring it back</button>
      </Empty>
    );
  }

  // A click opens just that tab. Shift+click splits the clicked tab with the one already open (in the split view, the
  // one picked last), so switching tabs never splits by accident. Shift+click on one side of the split view closes
  // that side, and the other tab stays open on its own.
  function selectTab(t: TabId, withOpen: boolean) {
    if (withOpen) {
      if (split && recent.includes(t)) {
        const other = recent[0] === t ? recent[1] : recent[0];
        setRecent([other, t]);
        setSplit(false);
        return;
      }
      if (t === recent[0]) return;
      setRecent([t, recent[0]]);
      setSplit(true);
      return;
    }
    setRecent((r) => (r[0] === t ? r : [t, r[0]]));
    setSplit(false);
  }

  const dropArea = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const spot = dropSpot(e.clientX, e.clientY);
      if (spot !== dropBefore) setDropBefore(spot);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropBefore(undefined); },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      e.preventDefault();
      const spot = dropSpot(e.clientX, e.clientY);
      if (spot !== undefined) moveTab(dragging, spot);
      endDrag();
    },
  };
  const back = vertical ? 'ArrowUp' : 'ArrowLeft';
  const ahead = vertical ? 'ArrowDown' : 'ArrowRight';

  const nav = (
    <nav className="cw-tabs" aria-label="Views" ref={tabNav}>
      {tabs.map((t) => (
        <span
          key={t.id}
          data-tab={t.id}
          className={`cw-tab${shownTabs.has(t.id) ? ' active' : ''}${dragging === t.id ? ' dragging' : ''}${dropBefore === t.id ? ' drop-before' : ''}${dropBefore === null && t.id === tabs[tabs.length - 1].id ? ' drop-after' : ''}`}
          draggable={!phone}
          title={`Shift+click to show beside the open tab. Drag to reorder (or Alt + ${vertical ? 'up/down' : 'arrow'} keys)`}
          onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
          onDragEnd={endDrag}
        >
          <button type="button" className="cw-tab-main" aria-current={shownTabs.has(t.id) ? 'page' : undefined}
            aria-keyshortcuts={`Alt+${back} Alt+${ahead}`}
            onClick={(e) => selectTab(t.id, e.shiftKey)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== back && e.key !== ahead)) return;
              e.preventDefault();
              nudgeTab(t.id, e.key === back ? -1 : 1);
            }}>
            <span aria-hidden="true">[</span>
            <PixelIcon name={t.icon} size={phone ? 18 : 14} />
            <span>{phone || rail ? (t.short ?? t.label) : t.label}</span>
            {t.id === 'text' && textUnread > 0 && !textOnScreen && (
              <span className="cw-badge" aria-label={`${textUnread} unread`}>{textUnread > 99 ? '99+' : textUnread}</span>
            )}
            {t.id === 'voice' && callChannelId && callChannelId === voice?.id && <span className="cw-tab-live" aria-label="You are in the call" />}
            <span aria-hidden="true">]</span>
          </button>
          <button type="button" className="icon cw-tab-pop" title={isPopped(t.id) ? `Bring ${t.label} back` : `Pop out ${t.label}`}
            aria-label={isPopped(t.id) ? `Bring ${t.label} back` : `Pop out ${t.label}`}
            onClick={() => (isPopped(t.id) ? bringBack(t.id) : popOut(t.id))}>
            <PixelIcon name={isPopped(t.id) ? 'close' : 'popout'} size={10} />
          </button>
        </span>
      ))}
      {onOpenMovies && (
        <span className="cw-tab">
          <button type="button" className="cw-tab-main" title="Browse the Jellyfin library" onClick={onOpenMovies}>
            <span aria-hidden="true">[</span><PixelIcon name="movies" size={phone ? 18 : 14} /><span>Movies</span><span aria-hidden="true">]</span>
          </button>
        </span>
      )}
    </nav>
  );

  // The watch party stays mounted once it has been opened, in its own place in TabStage, and is only hidden while another
  // tab is shown. So its player keeps playing when the tab changes or the split view is turned on or off, instead of
  // reloading. Popping the tab out moves the panel into the pop-out window, so it is unmounted here.
  const watchOn = !isPopped('watch') && (split ? leftTab === 'watch' || rightTab === 'watch' : tab === 'watch');
  // Mounted while it is on screen, and kept mounted after that only while you are in it, so leaving stops the player.
  const [watchOpened, setWatchOpened] = useState(false);
  useEffect(() => { if (watchOn) setWatchOpened(true); else if (watchLeft) setWatchOpened(false); }, [watchOn, watchLeft]);
  // Playing while its tab is left: the panel shows as a small corner preview, and clicking it goes back to the tab.
  const watchPlace: WatchPane['place'] = watchOn ? (split ? (leftTab === 'watch' ? 'left' : 'right') : 'only') : null;
  const watchMini = watchOpened && !watchOn && !isPopped('watch') && watchPlaying;
  // A voice screen share shows as a corner preview while the Voice tab is not on screen (and not popped out).
  const share = useScreenShare(voice?.serverId, voice?.id);
  const streamMini = !!share && !shownTabs.has('voice') && !isPopped('voice');
  const sidePane = (t: TabId, shown: boolean): SidePane => ({ id: t, label: label(t), shown, node: shown ? slot(t) : null });
  const main = (
    <main className="cw-tabs-main" data-region="main">
      <TabStage
        split={split}
        left={sidePane(split ? leftTab : tab, (split ? leftTab : tab) !== 'watch' || isPopped('watch'))}
        right={sidePane(rightTab, split && (rightTab !== 'watch' || isPopped('watch')))}
        watch={{ place: watchPlace ?? (watchMini ? 'mini' : null), node: watchOpened && !isPopped('watch') ? pane('watch') : null, onExpand: () => selectTab('watch', false) }}
        stream={{ shown: streamMini, feed: share?.feed ?? null, name: share?.name ?? '', onExpand: () => selectTab('voice', false) }}
      />
    </main>
  );

  const showMembers = !!bundle && !(theaterKey !== null && membersHidden);

  const windows = (
    <>
      {popped.map((t) => (
        <PopoutWindow key={t} id={t} title={`Chatward · ${label(t)}`} onClose={() => bringBack(t)}
          shellClass={frame === 'orbit' ? 'orbit-shell' : undefined} backdrop={frame === 'orbit' ? <OrbitBackdrop /> : null}>
          {pane(t)}
        </PopoutWindow>
      ))}
      {serverSettingsOpen && serverId && (
        <ServerSettingsDialog serverId={serverId} onClose={() => setServerSettingsOpen(false)} onReload={onReload} />
      )}
    </>
  );

  if (frame === 'lcars') {
    return (
      <LcarsLayout
        serverName={bundle?.server.name ?? 'Chatward'}
        nav={nav}
        dropArea={dropArea}
        main={main}
        members={showMembers && bundle ? <MemberList serverId={bundle.server.id} members={members} /> : null}
        membersToggle={theaterKey !== null ? { hidden: membersHidden, toggle: () => setMembersHidden((h) => !h) } : null}
        onOpenServerSettings={canOpenServerSettings ? () => setServerSettingsOpen(true) : null}
        onOpenSettings={() => onOpenSettings()}
        onJoinVoice={joinVoice ?? null}
        windows={windows}
      />
    );
  }

  const orbit = frame === 'orbit';
  const side = (className: string) => (
    <div className={className} data-region="side">
      {showMembers && bundle && <MemberList serverId={bundle.server.id} members={members} showSpeaking={orbit} />}
      <section className="cw-me" aria-label="You">
        <div className="cw-me-head">
          {user && (
            <span className="cw-avatar-wrap">
              <Avatar user={user} size={32} />
              <span className={`cw-dot ${myStatus}`} aria-hidden="true" />
            </span>
          )}
          <strong className="cw-me-name">{user?.displayName ?? ''}</strong>
          <StatusPicker />
        </div>
        <VoiceDock stacked words={orbit || rail} />
      </section>
    </div>
  );

  if (phone) {
    // Same pieces as the wide layout: the server name, the tool buttons and the tab bar, with the member list in a drawer
    // and your card (status, notifications, settings) in a sheet behind the gear.
    const inCall = !!callChannelId;
    const onlineCount = members.filter((m) => m.user.id === user?.id || (presence[m.user.id] ?? 'offline') !== 'offline').length;
    return (
      <div className="cw-tabs-shell cw-phone" data-region="shell" data-layout="phone">
        <header className="cw-tabs-bar cw-phone-top" data-region="tabs">
          <strong className="cw-tabs-server">{bundle?.server.name ?? 'Chatward'}</strong>
          <div className="cw-tabs-tools">
            <button type="button" className={`cw-tool${meOpen ? ' active' : ''}`} aria-label="You: status, notifications and settings" aria-expanded={meOpen} onClick={() => setMeOpen(true)}>
              <PixelIcon name="gear" size={16} />
              {myStatus !== 'online' && <span className={`cw-dot-inline ${myStatus}`} aria-hidden="true" />}
            </button>
            <button type="button" className={`cw-tool${drawerOpen ? ' active' : ''}`} aria-expanded={drawerOpen}
              aria-label={`People, ${onlineCount} online`} onClick={() => setDrawerOpen((o) => !o)}>
              <PixelIcon name="user" size={16} />
              <span>{onlineCount}</span>
              {inCall && <span className="cw-tab-live" aria-label="You are in the call" />}
            </button>
          </div>
        </header>
        {tab === 'text' && <NotifyPrompt />}
        {main}
        {inCall && tab !== 'voice' && (
          <button type="button" className="cw-tool cw-call-pill" onClick={() => selectTab('voice', false)}>
            <span className="cw-tab-live" aria-hidden="true" />
            <span className="cw-call-pill-text">In voice{voice ? ` · ${voice.name}` : ''}</span>
            <span>Open</span>
          </button>
        )}
        <footer className="cw-phone-bottom">{nav}</footer>
        {drawerOpen && <div className="cw-phone-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
        <div className={`cw-tabs-side cw-phone-drawer${drawerOpen ? ' open' : ''}`} data-region="side" aria-hidden={!drawerOpen}>
          {bundle && <MemberList serverId={bundle.server.id} members={members} />}
        </div>
        {meOpen && (
          <MeSheet onClose={() => setMeOpen(false)} onOpenSettings={() => onOpenSettings()}
            onOpenServerSettings={canOpenServerSettings ? () => setServerSettingsOpen(true) : null} />
        )}
        {windows}
      </div>
    );
  }
  return (
    <div className={`cw-tabs-shell${orbit ? ' orbit-shell' : ''}`} data-region="shell" data-layout={orbit ? 'orbit' : 'tabs'} data-tabbar={rail ? 'side' : 'top'}>
      {orbit && <OrbitBackdrop />}
      <header className="cw-tabs-bar" data-region="tabs" {...dropArea}>
        {orbit
          ? <span className="orbit-brand"><OrbitMark /><strong className="cw-tabs-server">{bundle?.server.name ?? 'Chatward'}</strong></span>
          : <strong className="cw-tabs-server">{bundle?.server.name ?? 'Chatward'}</strong>}
        {nav}
        <div className="cw-tabs-tools">
          {theaterKey !== null && (
            <button type="button" className="cw-tool" aria-pressed={membersHidden} onClick={() => setMembersHidden((h) => !h)}>
              {membersHidden ? 'Show members' : 'Hide members'}
            </button>
          )}
          {rail
            ? <MysteryButton className="cw-tool"><span aria-hidden="true">🔪</span><span>Mystery</span></MysteryButton>
            : <MysteryButton className="icon cw-tool-icon" />}
          {canOpenServerSettings && (
            <button type="button" className="cw-tool" title="Server settings" aria-label="Server settings" onClick={() => setServerSettingsOpen(true)}>
              <PixelIcon name="gear" size={14} />
              <span>Server</span>
            </button>
          )}
          <button type="button" className={rail ? 'cw-tool' : 'icon cw-tool-icon'} title="Settings" aria-label="Settings" onClick={() => onOpenSettings()}>
            <PixelIcon name="gear" size={rail ? 14 : 16} />
            {rail && <span>Settings</span>}
          </button>
        </div>
        {orbit && <OrbitWindowButtons />}
      </header>

      {main}

      {/* the right column: members on top, and your status and call controls in the bottom corner */}
      {side('cw-tabs-side')}

      {windows}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="cw-tab-empty muted">{children}</div>;
}

/** One pane of the main area. `shown` is false when its tab is hidden here (the watch party, or the right side when not split). */
interface SidePane { id: TabId; label: string; shown: boolean; node: ReactNode }
/** The watch party's panel: where it is shown (null = hidden), and its content. */
interface WatchPane { place: 'left' | 'right' | 'only' | 'mini' | null; node: ReactNode; onExpand: () => void }
/** A voice screen share shown as a corner preview: whether it is shown, its picture, and whose it is. */
interface StreamPane { shown: boolean; feed: Feed | null; name: string; onExpand: () => void }

/**
 * The main area: one pane, or two side by side (text on the left, voice on the right, with a divider to drag or use the
 * arrow keys). All panes are always in the same grid at fixed positions, so switching tabs or turning the split view on
 * or off only changes what is shown, and never unmounts the watch party. The watch party is hidden, not unmounted.
 */
function TabStage({ split, left, right, watch, stream }: { split: boolean; left: SidePane; right: SidePane; watch: WatchPane; stream: StreamPane }) {
  const mini = watch.place === 'mini';
  // Both corner previews can be moved and resized. The watch party starts bottom-right and a screen share bottom-left,
  // so both can show at once without covering each other.
  const watchFloat = useFloatingBox('watch', 'br');
  const streamFloat = useFloatingBox('stream', 'bl');
  // the saved ratio is the left side's share of the width
  const saved = useSettings((s) => s.splitRatio);
  const set = useSettings((s) => s.set);
  const [ratio, setRatio] = useState(() => clampSplit(saved));
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(ratio);
  latest.current = ratio;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setRatio(clampSplit((e.clientX - r.left) / r.width));
  };
  const save = () => set({ splitRatio: latest.current });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0;
    if (!step) return;
    e.preventDefault();
    const next = clampSplit(latest.current + step);
    setRatio(next);
    set({ splitRatio: next });
  };

  // Both shares are at least 1fr, so when one side is held at its minimum width the other still fills the rest.
  const col = (p: SidePane, share: number) => `minmax(${p.id === 'text' ? TEXT_MIN : '0px'}, ${Math.max(1, share)}fr)`;
  // Hidden panes are display:none, so they take no cell. Every pane has an explicit column and row, so the grid never reflows.
  const show = (on: boolean) => (on ? undefined : 'none');
  return (
    <div className="cw-split" ref={box} style={{ gridTemplateColumns: split ? `${col(left, ratio / (1 - ratio))} 8px ${col(right, (1 - ratio) / ratio)}` : 'minmax(0, 1fr)' }}>
      <section className="cw-split-pane" aria-label={left.label} style={{ gridColumn: 1, gridRow: 1, display: show(left.shown) }}>{left.node}</section>
      {split && (
        <div
          className="cw-split-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${left.label} and ${right.label}`}
          aria-valuemin={MIN_SPLIT * 100}
          aria-valuemax={MAX_SPLIT * 100}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          style={{ gridColumn: 2, gridRow: 1 }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={onMove}
          onPointerUp={save}
          onLostPointerCapture={save}
          onKeyDown={onKey}
        />
      )}
      <section className="cw-split-pane" aria-label={right.label} style={{ gridColumn: 3, gridRow: 1, display: show(split && right.shown) }}>{right.node}</section>
      <section
        className={`cw-split-pane${mini ? ' cw-watch-mini cw-float-mini' : ''}`}
        aria-label="Watch together"
        style={{ gridColumn: watch.place === 'right' ? 3 : 1, gridRow: 1, display: show(watch.place !== null), ...(mini ? watchFloat.style : {}) }}
      >
        {mini && (
          <div className="cw-float-grip" {...watchFloat.move}>
            <button type="button" className="cw-float-open" onPointerDown={(e) => e.stopPropagation()} onClick={watch.onExpand}>Watch together</button>
          </div>
        )}
        {mini && <div className="cw-float-resize" {...watchFloat.resize} aria-hidden="true" />}
        {watch.node}
      </section>
      {stream.shown && stream.feed && (
        <section className="cw-split-pane cw-float-mini cw-stream-mini" aria-label="Screen share" style={{ ...streamFloat.style, gridColumn: 1, gridRow: 1 }}>
          <div className="cw-float-grip" {...streamFloat.move}>
            <span className="cw-float-title">{stream.name} · screen</span>
            <button type="button" className="cw-float-open" onPointerDown={(e) => e.stopPropagation()} onClick={stream.onExpand}>Voice</button>
          </div>
          <VideoView feed={stream.feed} mirror={false} />
          <div className="cw-float-resize" {...streamFloat.resize} aria-hidden="true" />
        </section>
      )}
    </div>
  );
}
