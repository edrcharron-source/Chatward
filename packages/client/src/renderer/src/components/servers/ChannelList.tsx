import { useState, type FormEvent } from 'react';
import { LIMITS, type Channel, type User } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import { GUEST_USERS, isGuest, useGuests } from '../../state/guests';
import { useMemberMenu } from '../voice/MemberMenu';
import VoiceDock from '../voice/VoiceDock';
import Avatar from './Avatar';
import ChannelSettingsDialog from './ChannelSettingsDialog';
import Dialog from './Dialog';
import ServerSettingsDialog from './ServerSettingsDialog';
import StatusPicker from './StatusPicker';
import { errorText, isAdmin } from './util';
import './servers.css';
import ProfileTrigger from '../profile/ProfileTrigger';

type DialogKind = 'channel' | 'server' | null;

export default function ChannelList({ onOpenSettings, onReload }: { onOpenSettings: () => void; onReload: () => Promise<void> }) {
  const user = useSession((s) => s.user);
  const servers = useSession((s) => s.servers);
  const activeServerId = useSession((s) => s.activeServerId);
  const activeChannelId = useSession((s) => s.activeChannelId);
  const voiceOccupants = useSession((s) => s.voiceOccupants);
  const myStatus = useSession((s) => s.myStatus);
  const unread = useSession((s) => s.unread);
  const joinedVoiceId = useVoice((s) => s.channelId);
  const speaking = useVoice((s) => s.speaking);
  const guestSpeaking = useGuests((s) => s.speaking);
  const guestRoom = useGuests((s) => (activeServerId ? s.rooms[activeServerId] : undefined));
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null);
  const memberMenu = useMemberMenu();

  const bundle = servers.find((b) => b.server.id === activeServerId);
  const admin = isAdmin(bundle?.members.find((m) => m.user.id === user?.id));
  const textChannels = bundle?.channels.filter((c) => c.kind === 'text') ?? [];
  const voiceChannels = bundle?.channels.filter((c) => c.kind === 'voice') ?? [];

  function openText(c: Channel) {
    const st = useSession.getState();
    st.setActive(c.serverId, c.id);
    st.clearUnread(c.id);
  }

  async function openVoice(c: Channel) {
    setVoiceError(null);
    useSession.getState().setActive(c.serverId, c.id);
    try {
      await useVoice.getState().join(c.serverId, c.id);
    } catch (err) {
      setVoiceError(errorText(err));
    }
  }

  function occupantsOf(channelId: string): User[] {
    const ids = voiceOccupants[channelId] ?? [];
    // the server may not list us yet (and demo calls never do), so add the local user while connected
    const listed = channelId === joinedVoiceId && user && !ids.includes(user.id) ? [user.id, ...ids] : ids;
    return listed.flatMap((id) => {
      const m = bundle?.members.find((x) => x.user.id === id);
      return m ? [m.user] : [];
    }).concat(channelId === guestRoom?.voiceChannelId ? guestRoom.inVoice.flatMap((g) => GUEST_USERS[g] ?? []) : []);
  }

  return (
    <aside className="cw-channels" data-region="channels" aria-label="Channels">
      <header className="cw-channels-head">
        <h2>{bundle?.server.name ?? 'Chatward'}</h2>
        {bundle && (
          <div className="cw-head-actions">
            {admin && <button type="button" className="icon" title="Create channel" aria-label="Create channel" onClick={() => setDialog('channel')}>＋</button>}
            <button type="button" className="icon" title="Server settings" aria-label="Server settings" onClick={() => setDialog('server')}>⚙</button>
          </div>
        )}
      </header>

      <div className="cw-channels-body">
        {!bundle && <p className="muted" style={{ padding: '0 8px' }}>No server selected.</p>}

        {bundle && (
          <>
            <section className="cw-section">
              <div className="cw-section-title"><span>Text channels</span></div>
              {textChannels.map((c) => {
                const count = unread[c.id] ?? 0;
                const active = c.id === activeChannelId;
                return (
                  <div key={c.id} className="cw-voice-row">
                    <button
                      type="button"
                      className={`cw-channel${active ? ' active' : ''}${count > 0 ? ' unread' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => openText(c)}
                    >
                      <span className="cw-channel-icon" aria-hidden="true">#</span>
                      <span className="cw-channel-name">{c.name}</span>
                      {count > 0 && <span className="cw-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>}
                    </button>
                    {admin && (
                      <button type="button" className="icon cw-channel-gear" title={`${c.name} settings`} aria-label={`${c.name} settings`} onClick={() => setSettingsChannel(c)}>⚙</button>
                    )}
                  </div>
                );
              })}
            </section>

            <section className="cw-section">
              <div className="cw-section-title"><span>Voice channels</span></div>
              {voiceChannels.map((c) => {
                const occupants = occupantsOf(c.id);
                const active = c.id === activeChannelId;
                const inCall = c.id === joinedVoiceId;
                return (
                  <div key={c.id} className="cw-voice-row">
                    <button
                      type="button"
                      className={`cw-channel${active ? ' active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => void openVoice(c)}
                    >
                      <span className="cw-channel-icon" aria-hidden="true">🔊</span>
                      <span className="cw-channel-name">{c.name}</span>
                      {inCall && <span className="cw-here">Connected</span>}
                    </button>
                    {admin && (
                      <button type="button" className="icon cw-channel-gear" title={`${c.name} settings`} aria-label={`${c.name} settings`} onClick={() => setSettingsChannel(c)}>⚙</button>
                    )}
                    {occupants.length > 0 && (
                      <ul className="cw-occupants" aria-label={`In ${c.name}`}>
                        {occupants.map((u) => (
                          <li
                            key={u.id}
                            data-speaking={speaking.includes(u.id) || guestSpeaking.includes(u.id) || undefined}
                            onContextMenu={u.id === user?.id || isGuest(u.id) ? undefined : (e) => memberMenu.openMenu(e, { userId: u.id, channelId: c.id, serverId: c.serverId })}
                          >
                            <ProfileTrigger user={u}>
                              <Avatar user={u} size={18} />
                              <span>{u.displayName}</span>
                            </ProfileTrigger>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>

            {voiceError && <p className="cw-error" role="alert">{voiceError}</p>}
          </>
        )}
      </div>
      {memberMenu.element}

      <VoiceDock />

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
        <button type="button" className="icon" title="Settings" aria-label="Settings" onClick={onOpenSettings}>⚙</button>
      </div>

      {dialog === 'channel' && bundle && (
        <CreateChannelDialog serverId={bundle.server.id} onClose={() => setDialog(null)} onReload={onReload} />
      )}
      {settingsChannel && (
        <ChannelSettingsDialog channel={settingsChannel} onClose={() => setSettingsChannel(null)} onReload={onReload} />
      )}
      {dialog === 'server' && bundle && (
        <ServerSettingsDialog serverId={bundle.server.id} onClose={() => setDialog(null)} onReload={onReload} />
      )}
    </aside>
  );
}

function CreateChannelDialog({ serverId, onClose, onReload }: { serverId: string; onClose: () => void; onReload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Channel['kind']>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Name the channel.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post<{ channel: Channel }>(`/api/servers/${serverId}/channels`, { name: trimmed, kind });
      await onReload();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create a channel" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Channel name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.CHANNEL_NAME_MAX} autoFocus required />
        </label>
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as Channel['kind'])}>
            <option value="text">Text</option>
            <option value="voice">Voice</option>
          </select>
        </label>
        {error && <p className="cw-error" role="alert">{error}</p>}
        <div className="cw-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create channel'}</button>
        </div>
      </form>
    </Dialog>
  );
}
