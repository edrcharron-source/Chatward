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

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
/** The chat side never gets narrower than this, so there is room to read and type. The voice side's share is 1fr,
 *  so it still fills the rest when the chat side is held at this width. */
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
  const [tab, setTab] = useState<TabId>('text');
  const [split, setSplit] = useState(false);
  const [popped, setPopped] = useState<TabId[]>([]);
  const [membersHidden, setMembersHidden] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);

  const serverId = bundle?.server.id;
  const text = bundle?.channels.find((c) => c.kind === 'text');
  const voice = bundle?.channels.find((c) => c.kind === 'voice');
  const members = (bundle?.members ?? []) as Member[];
  const me = members.find((m) => m.user.id === user?.id);
  const isPopped = (t: TabId) => popped.includes(t);
  const textUnread = text ? unread[text.id] ?? 0 : 0;

  // The chat counts as read while it is on screen: its tab, the split view, or its own window.
  const textOnScreen = tab === 'text' || split || isPopped('text');
  const activeId = tab === 'voice' && !split ? voice?.id : text?.id;
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

  function selectTab(t: TabId) {
    setTab(t);
    // the split view is text and voice together, so picking another tab leaves it
    if (t !== 'text' && t !== 'voice') setSplit(false);
  }

  const shownTabs = new Set<TabId>(split ? ['text', 'voice'] : [tab]);

  return (
    <div className="cw-tabs-shell" data-region="shell" data-layout="tabs">
      <header className="cw-tabs-bar" data-region="tabs">
        <strong className="cw-tabs-server">{bundle?.server.name ?? 'Chatward'}</strong>
        <nav className="cw-tabs" aria-label="Views">
          {TABS.map((t) => (
            <span key={t.id} className={`cw-tab${shownTabs.has(t.id) ? ' active' : ''}`}>
              <button type="button" className="cw-tab-main" aria-current={shownTabs.has(t.id) ? 'page' : undefined} onClick={() => selectTab(t.id)}>
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
            title="Text on the left, voice on the right" onClick={() => { setSplit((s) => !s); if (tab !== 'voice') setTab('text'); }}>
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
          ? <SideBySide left={slot('text')} right={slot('voice')} />
          : <div className="cw-tab-pane">{slot(tab)}</div>}
      </main>

      {bundle && !(theaterKey !== null && membersHidden) && <MemberList serverId={bundle.server.id} members={members} />}

      <footer className="cw-tabs-footer" data-region="footer">
        <div className="cw-user-panel">
          {user && (
            <span className="cw-avatar-wrap">
              <Avatar user={user} size={32} />
              <span className={`cw-dot ${myStatus}`} aria-hidden="true" />
            </span>
          )}
          <div className="cw-user-text">
            <strong>{user?.displayName ?? ''}</strong>
            <StatusPicker />
          </div>
        </div>
        <div className="cw-tabs-call">
          <VoiceDock />
        </div>
      </footer>

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
function SideBySide({ left, right }: { left: ReactNode; right: ReactNode }) {
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

  return (
    <div className="cw-split" ref={box} style={{ gridTemplateColumns: `minmax(${TEXT_MIN}, ${ratio / (1 - ratio)}fr) 8px minmax(0, 1fr)` }}>
      <section className="cw-split-pane" aria-label="Text">{left}</section>
      <div
        className="cw-split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize text and voice"
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
      <section className="cw-split-pane" aria-label="Voice">{right}</section>
    </div>
  );
}
