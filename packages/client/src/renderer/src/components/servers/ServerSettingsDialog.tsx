import { useState, type FormEvent } from 'react';
import { LIMITS, type Member } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import Dialog from './Dialog';
import { errorText } from './util';

/**
 * Server-wide settings. Everyone can leave. Admins can rename. The owner can make admins and delete the server.
 * Removing people is handled elsewhere in the member list.
 */
export default function ServerSettingsDialog({ serverId, onClose, onReload }: { serverId: string; onClose: () => void; onReload: () => Promise<void> }) {
  const bundle = useSession((s) => s.servers.find((b) => b.server.id === serverId));
  const me = useSession((s) => s.user);
  const [name, setName] = useState(bundle?.server.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bundle) return null;
  const serverName = bundle.server.name;
  const myRole = bundle.members.find((m) => m.user.id === me?.id)?.role;
  const isOwner = myRole === 'owner';
  const isAdmin = isOwner || myRole === 'admin';

  /** Runs one request, then shows any error. Closes the dialog on success when `done` is set. */
  async function run(fn: () => Promise<unknown>, done = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (done) onClose();
      else await onReload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Give your server a name.'); return; }
    await run(async () => {
      await api.patch(`/api/servers/${serverId}`, { name: trimmed });
      await onReload();
    });
  }

  async function setRole(member: Member, role: 'admin' | 'member') {
    await run(async () => {
      await api.patch(`/api/servers/${serverId}/members/${member.user.id}`, { role });
      const latest = useSession.getState().servers.find((b) => b.server.id === serverId);
      if (latest) {
        useSession.getState().upsertServer({
          ...latest,
          members: latest.members.map((m) => (m.user.id === member.user.id ? { ...m, role } : m)),
        });
      }
    });
  }

  async function leave() {
    if (!window.confirm(`Leave ${serverName}? You will need a new invite to come back.`)) return;
    await run(async () => {
      await api.post(`/api/servers/${serverId}/leave`, {});
      useSession.getState().removeServer(serverId);
    }, true);
  }

  async function remove() {
    if (!window.confirm(`Delete ${serverName}? All channels and messages are deleted for everyone. This cannot be undone.`)) return;
    await run(async () => {
      await api.del(`/api/servers/${serverId}`);
      useSession.getState().removeServer(serverId);
    }, true);
  }

  const others = bundle.members.filter((m) => m.role !== 'owner');

  return (
    <Dialog title={`${serverName} settings`} onClose={onClose}>
      {isAdmin && (
        <form onSubmit={rename}>
          <label>
            Server name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.SERVER_NAME_MAX} required />
          </label>
          <div className="cw-dialog-actions">
            <button type="submit" className="primary" disabled={busy}>Save name</button>
          </div>
        </form>
      )}

      {isOwner && (
        <section aria-label="Roles">
          <h3>Admins</h3>
          <p className="cw-hint">Admins can create, rename and delete channels, and change the server name.</p>
          <ul className="cw-role-list">
            {others.map((m) => (
              <li key={m.user.id}>
                <span>{m.user.displayName} <span className="muted">@{m.user.username}</span></span>
                <select value={m.role} disabled={busy} onChange={(e) => void setRole(m, e.target.value as 'admin' | 'member')} aria-label={`Role for ${m.user.displayName}`}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="cw-error" role="alert">{error}</p>}

      <div className="cw-dialog-actions">
        {isOwner ? (
          <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Delete server</button>
        ) : (
          <button type="button" className="danger" onClick={() => void leave()} disabled={busy}>Leave server</button>
        )}
      </div>
      {isOwner && <p className="cw-hint">The owner cannot leave. Deleting the server is the only way to close it.</p>}
    </Dialog>
  );
}
