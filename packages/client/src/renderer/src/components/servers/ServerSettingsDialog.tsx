import { useEffect, useState, type FormEvent } from 'react';
import { LIMITS, type Member, type User } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import Avatar from './Avatar';
import Dialog from './Dialog';
import { errorText } from './util';

type TurnedOff = { user: User; bannedAt: number };

/**
 * Settings for the one server. Admins can rename it and turn removed accounts back on. The owner can make admins and
 * issue password reset codes. Removing people is handled in the member list; new people sign up with a code from
 * `chatward invite` on the server.
 */
export default function ServerSettingsDialog({ serverId, onClose, onReload }: { serverId: string; onClose: () => void; onReload: () => Promise<void> }) {
  const bundle = useSession((s) => s.servers.find((b) => b.server.id === serverId));
  const me = useSession((s) => s.user);
  const [name, setName] = useState(bundle?.server.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; code: string; expiresAt: number } | null>(null);
  const [turnedOff, setTurnedOff] = useState<TurnedOff[]>([]);
  const myRoleNow = bundle?.members.find((m) => m.user.id === me?.id)?.role;
  const canModerate = myRoleNow === 'owner' || myRoleNow === 'admin';

  async function loadTurnedOff() {
    try {
      setTurnedOff((await api.get<{ bans: TurnedOff[] }>(`/api/servers/${serverId}/bans`)).bans);
    } catch (err) {
      setError(errorText(err));
    }
  }
  useEffect(() => { if (canModerate) void loadTurnedOff(); }, [serverId, canModerate]);

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

  async function turnBackOn(user: User) {
    await run(async () => {
      await api.del(`/api/servers/${serverId}/bans/${encodeURIComponent(user.id)}`);
      await loadTurnedOff();
    });
  }

  const others = bundle.members.filter((m) => m.role !== 'owner');

  /** Issues a one-time reset code for a member. The code is shown once, here, for the owner to pass on. */
  async function issueResetCode(member: Member) {
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const res = await api.post<{ code: string; expiresAt: number }>(`/api/servers/${serverId}/members/${member.user.id}/reset-code`);
      setIssued({ name: member.user.displayName, code: res.code, expiresAt: res.expiresAt });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

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
                <span>{m.user.displayName}</span>
                <select value={m.role} disabled={busy} onChange={(e) => void setRole(m, e.target.value as 'admin' | 'member')} aria-label={`Role for ${m.user.displayName}`}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOwner && (
        <section aria-label="Password reset">
          <h3>Password reset</h3>
          <p className="cw-hint">
            If a member forgets their password, issue a one-time code and pass it on in person or in a private message.
            It works once and expires after 24 hours. You can sign in as that member with it, so only do this for someone you trust.
          </p>
          <ul className="cw-role-list">
            {others.map((m) => (
              <li key={m.user.id}>
                <span>{m.user.displayName}</span>
                <button type="button" disabled={busy} onClick={() => void issueResetCode(m)} aria-label={`Issue reset code for ${m.user.displayName}`}>Reset code</button>
              </li>
            ))}
          </ul>
          {issued && (
            <p className="cw-hint" role="status">
              Reset code for {issued.name}: <strong>{issued.code}</strong>. Expires {new Date(issued.expiresAt).toLocaleString()}.
            </p>
          )}
        </section>
      )}

      {isAdmin && (
        <section aria-label="Removed accounts">
          <h3>Removed accounts</h3>
          <p className="cw-hint">People removed from the member list can't sign in. Turn an account back on to let them in again.</p>
          {turnedOff.length === 0 && <p className="cw-hint">Nobody has been removed.</p>}
          <ul className="cw-role-list">
            {turnedOff.map((b) => (
              <li key={b.user.id}>
                <span className="cw-ban-user"><Avatar user={b.user} size={24} />{b.user.displayName}</span>
                <button type="button" disabled={busy} onClick={() => void turnBackOn(b.user)}>Turn back on</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="cw-error" role="alert">{error}</p>}
      <p className="cw-hint">To add someone, run <code>chatward invite</code> on the server and send them the code it prints.</p>
    </Dialog>
  );
}
