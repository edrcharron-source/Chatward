import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Member } from '@chatward/shared';
import { useSession, type ServerBundle } from '../../state/session';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import ChatView from '../chat/ChatView';
import VoiceChannelView from '../voice/VoiceChannelView';
import VoiceDock from '../voice/VoiceDock';
import VaultView from '../vault/VaultView';
import { WatchPartyPanel } from '../watchparty';
import MemberList from '../servers/MemberList';
import StatusPicker from '../servers/StatusPicker';
import ServerSettingsDialog from '../servers/ServerSettingsDialog';
import Avatar from '../servers/Avatar';
import { isAdmin } from '../servers/util';
import PixelIcon, { type PixelIconName } from '../icons/PixelIcon';
import { PopoutWindow } from './PopoutWindow';
import './tabs.css';

type TabId = 'text' | 'voice' | 'watch' | 'vault';

const TABS: Array<{ id: TabId; label: string; icon: PixelIconName }> = [
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'watch', label: 'Watch together', icon: 'watch' },
  { id: 'vault', label: 'Vault', icon: 'vault' },
];

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
 */
export default function TabsLayout({ bundle, onOpenSettings, onReload, onOpenTest, onOpenMovies }: {
  bundle: ServerBundle | undefined;
  onOpenSettings: () => void;
  onReload: () => Promise<void>;
  onOpenTest: () => void;
  onOpenMovies: (() => void) | null;
}) {
  const user = useSession((s) => s.user);
  const myStatus = useSession((s) => s.myStatus);
  const unread = useSession((s) => s.unread);
  const callChannelId = useVoice((s) => s.channelId);
  const theaterKey = useVoice((s) => s.theaterKey);
  const join = useVoice((s) => s.join);
  // the last two tabs picked, newest first: the open tab is the first, and the split view shows both
  const [recent, setRecent] = useState<[TabId, TabId]>(['text', 'voice']);
  const tab = recent[0];
  const [split, setSplit] = useState(false);
  const [popped, setPopped] = useState<TabId[]>([]);
  const [membersHidden, setMembersHidden] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const savedOrder = useSettings((s) => s.tabOrder);
  const setSettings = useSettings((s) => s.set);
  const tabs = orderTabs(savedOrder);
  const [dragging, setDragging] = useState<TabId | null>(null);
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
        return text ? <ChatView key={text.id} channel={text} /> : <Empty>This server has no text chat yet.</Empty>;
      case 'voice':
        return voice ? <VoiceChannelView key={voice.id} channel={voice} /> : <Empty>This server has no voice chat yet.</Empty>;
      case 'watch':
        // Voice channels have no message key of their own, so the watch party rides the text chat's key.
        return callChannelId && text
          ? <div className="cw-tab-scroll"><WatchPartyPanel key={`watch-${callChannelId}`} callChannelId={callChannelId} keyChannelId={text.id} /></div>
          : (
            <Empty>
              <p>Join the voice chat to start or join a watch party.</p>
              {joinVoice && <button type="button" className="primary" onClick={joinVoice}>Join voice</button>}
            </Empty>
          );
      case 'vault':
        return <VaultView key={bundle.server.id} serverId={bundle.server.id} keyChannelId={text?.id} canModerate={isAdmin(me)} />;
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
  // one picked last), so switching tabs never splits by accident.
  function selectTab(t: TabId, withOpen: boolean) {
    if (withOpen) {
      if (t === recent[0]) return;
      setRecent([t, recent[0]]);
      setSplit(true);
      return;
    }
    setRecent((r) => (r[0] === t ? r : [t, r[0]]));
    setSplit(false);
  }

  return (
    <div className="cw-tabs-shell" data-region="shell" data-layout="tabs">
      <header className="cw-tabs-bar" data-region="tabs">
        <strong className="cw-tabs-server">{bundle?.server.name ?? 'Chatward'}</strong>
        <nav className="cw-tabs" aria-label="Views">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`cw-tab${shownTabs.has(t.id) ? ' active' : ''}${dragging === t.id ? ' dragging' : ''}`}
              draggable
              title="Shift+click to show beside the open tab. Drag to reorder (or Alt + arrow keys)"
              onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragging || dragging === t.id) return;
                // dropped on the right half of a tab: go after it
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > r.left + r.width / 2;
                const i = tabs.findIndex((x) => x.id === t.id);
                moveTab(dragging, after ? tabs[i + 1]?.id ?? null : t.id);
                setDragging(null);
              }}
            >
              <button type="button" className="cw-tab-main" aria-current={shownTabs.has(t.id) ? 'page' : undefined}
                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                onClick={(e) => selectTab(t.id, e.shiftKey)}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
                  e.preventDefault();
                  nudgeTab(t.id, e.key === 'ArrowLeft' ? -1 : 1);
                }}>
                <span aria-hidden="true">[</span>
                <PixelIcon name={t.icon} size={14} />
                <span>{t.label}</span>
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
                <span aria-hidden="true">[</span><PixelIcon name="movies" size={14} /><span>Movies</span><span aria-hidden="true">]</span>
              </button>
            </span>
          )}
        </nav>
        <div className="cw-tabs-tools">
          <button type="button" className={`cw-tool${split ? ' active' : ''}`} aria-pressed={split}
            title="Show the open tab beside the one before it (or Shift+click a tab)" onClick={() => setSplit((s) => !s)}>
            <PixelIcon name="theater" size={14} />
            <span>Split</span>
          </button>
          {theaterKey !== null && (
            <button type="button" className="cw-tool" aria-pressed={membersHidden} onClick={() => setMembersHidden((h) => !h)}>
              {membersHidden ? 'Show members' : 'Hide members'}
            </button>
          )}
          <button type="button" className="icon cw-tool-icon" title="Feature test console (Ctrl+Shift+T)" aria-label="Feature test console" onClick={onOpenTest}>
            <PixelIcon name="test" size={16} />
          </button>
          {bundle && (
            <button type="button" className="cw-tool" title="Server settings" aria-label="Server settings" onClick={() => setServerSettingsOpen(true)}>
              <PixelIcon name="gear" size={14} />
              <span>Server</span>
            </button>
          )}
          <button type="button" className="icon cw-tool-icon" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
            <PixelIcon name="gear" size={16} />
          </button>
        </div>
      </header>

      <main className="cw-tabs-main" data-region="main">
        {split
          ? <SideBySide
              left={{ id: leftTab, label: label(leftTab), node: slot(leftTab) }}
              right={{ id: rightTab, label: label(rightTab), node: slot(rightTab) }}
            />
          : <div className="cw-tab-pane">{slot(tab)}</div>}
      </main>

      {/* the right column: members on top, and your status and call controls in the bottom corner */}
      <div className="cw-tabs-side" data-region="side">
        {bundle && !(theaterKey !== null && membersHidden) && <MemberList serverId={bundle.server.id} members={members} />}
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
          <VoiceDock stacked />
        </section>
      </div>

      {popped.map((t) => (
        <PopoutWindow key={t} id={t} title={`Chatward · ${label(t)}`} onClose={() => bringBack(t)}>
          {pane(t)}
        </PopoutWindow>
      ))}
      {serverSettingsOpen && serverId && (
        <ServerSettingsDialog serverId={serverId} onClose={() => setServerSettingsOpen(false)} onReload={onReload} />
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="cw-tab-empty muted">{children}</div>;
}

/** Text on the left, voice on the right, with a divider to drag (or arrow keys) to share the width. */
interface SidePane { id: TabId; label: string; node: ReactNode }

function SideBySide({ left, right }: { left: SidePane; right: SidePane }) {
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
  return (
    <div className="cw-split" ref={box} style={{ gridTemplateColumns: `${col(left, ratio / (1 - ratio))} 8px ${col(right, (1 - ratio) / ratio)}` }}>
      <section key={left.id} className="cw-split-pane" aria-label={left.label}>{left.node}</section>
      <div
        className="cw-split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${left.label} and ${right.label}`}
        aria-valuemin={MIN_SPLIT * 100}
        aria-valuemax={MAX_SPLIT * 100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={onMove}
        onPointerUp={save}
        onLostPointerCapture={save}
        onKeyDown={onKey}
      />
      <section key={right.id} className="cw-split-pane" aria-label={right.label}>{right.node}</section>
    </div>
  );
}
