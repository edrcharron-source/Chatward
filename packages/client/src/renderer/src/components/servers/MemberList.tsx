import type { Member } from '@chatward/shared';
import { useSession } from '../../state/session';
import Avatar from './Avatar';
import './servers.css';

type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export default function MemberList({ members }: { members: Member[] }) {
  const presence = useSession((s) => s.presence);
  const meId = useSession((s) => s.user?.id);
  // Our own socket can miss its own presence frame, so count yourself as online by default.
  const statusOf = (m: Member): Presence => presence[m.user.id] ?? (m.user.id === meId ? 'online' : 'offline');

  const online = members.filter((m) => statusOf(m) !== 'offline');
  const offline = members.filter((m) => statusOf(m) === 'offline');

  return (
    <aside className="cw-members" aria-label="Members">
      {online.length > 0 && <Group title="Online" list={online} statusOf={statusOf} />}
      {offline.length > 0 && <Group title="Offline" list={offline} statusOf={statusOf} />}
    </aside>
  );
}

function Group({ title, list, statusOf }: { title: string; list: Member[]; statusOf: (m: Member) => Presence }) {
  return (
    <section className="cw-members-group">
      <h3 className="cw-members-title">{title} — {list.length}</h3>
      <ul className="cw-members-list">
        {list.map((m) => {
          const status = statusOf(m);
          return (
            <li key={m.user.id} className={`cw-member${status === 'offline' ? ' offline' : ''}`}>
              <div className="cw-avatar-wrap">
                <Avatar user={m.user} size={32} />
                <span className={`cw-dot ${status}`} aria-label={status} />
              </div>
              <span className="cw-member-name">{m.user.displayName}</span>
              {m.role !== 'member' && <span className="cw-role">{m.role}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
