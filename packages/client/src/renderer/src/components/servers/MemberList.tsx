import { useState, type ReactNode } from 'react';
import type { Member } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import Avatar from './Avatar';
import './servers.css';
import ProfileTrigger from '../profile/ProfileTrigger';
import { errorText } from './util';

type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export default function MemberList({ serverId, members }: { serverId: string; members: Member[] }) {
  const presence = useSession((s) => s.presence);
  const meId = useSession((s) => s.user?.id);
  const [error, setError] = useState<string | null>(null);
  // Our own socket can miss its own presence frame, so count yourself as online by default.
  const statusOf = (m: Member): Presence => presence[m.user.id] ?? (m.user.id === meId ? 'online' : 'offline');

  const myRole = members.find((m) => m.user.id === meId)?.role;
  // Admins can remove members; only the owner can act on an admin. The server enforces this too.
  const canActOn = (m: Member) =>
    m.user.id !== meId && (myRole === 'owner' || (myRole === 'admin' && m.role === 'member'));

  // There is one server, so removing someone turns their account off. Settings lists them to turn back on.
  async function remove(m: Member) {
    if (!window.confirm(`Remove ${m.user.displayName}? Their account is turned off: they are signed out everywhere and can't sign in until it is turned back on in Server settings.`)) return;
    setError(null);
    try {
      await api.del(`/api/servers/${serverId}/members/${encodeURIComponent(m.user.id)}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const actions = (m: Member): ReactNode => canActOn(m) && (
    <span className="cw-member-actions">
      <button type="button" className="danger" onClick={() => void remove(m)}>Remove</button>
    </span>
  );

  const online = members.filter((m) => statusOf(m) !== 'offline');
  const offline = members.filter((m) => statusOf(m) === 'offline');

  return (
    <aside className="cw-members" data-region="members" aria-label="Members">
      {online.length > 0 && <Group title="Online" list={online} statusOf={statusOf} actions={actions} />}
      {offline.length > 0 && <Group title="Offline" list={offline} statusOf={statusOf} actions={actions} />}
      {error && <p className="cw-error" role="alert">{error}</p>}
    </aside>
  );
}

function Group({ title, list, statusOf, actions }: {
  title: string;
  list: Member[];
  statusOf: (m: Member) => Presence;
  actions: (m: Member) => ReactNode;
}) {
  return (
    <section className="cw-members-group">
      <h3 className="cw-members-title">{title} — {list.length}</h3>
      <ul className="cw-members-list">
        {list.map((m) => {
          const status = statusOf(m);
          return (
            <li key={m.user.id} className={`cw-member${status === 'offline' ? ' offline' : ''}`}>
              <ProfileTrigger user={m.user} className="cw-member-profile">
                <span className="cw-avatar-wrap">
                  <Avatar user={m.user} size={32} />
                  <span className={`cw-dot ${status}`} aria-label={status} />
                </span>
                <span className="cw-member-name">{m.user.displayName}</span>
              </ProfileTrigger>
              {m.role !== 'member' && <span className="cw-role">{m.role}</span>}
              {actions(m)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
