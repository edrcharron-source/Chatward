import { useEffect, useState } from 'react';
import type { User } from '@chatward/shared';
import { api } from '../../api/http';
import Dialog from './Dialog';
import Avatar from './Avatar';
import { errorText } from './util';

type Invite = { code: string; expiresAt: number; maxUses: number; uses: number };
type Ban = { user: User; bannedAt: number };

/** Admin-only: make invites, revoke live ones, and lift bans. */
export default function InvitesDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [maxUses, setMaxUses] = useState(1);
  const [invite, setInvite] = useState<{ code: string; expiresAt: number | string } | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [inv, ban] = await Promise.all([
        api.get<{ invites: Invite[] }>(`/api/servers/${serverId}/invites`),
        api.get<{ bans: Ban[] }>(`/api/servers/${serverId}/bans`),
      ]);
      setInvites(inv.invites);
      setBans(ban.bans);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => { void load(); }, [serverId]);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setInvite(await api.post<{ code: string; expiresAt: number | string }>(`/api/servers/${serverId}/invites`, { maxUses }));
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the code and copy it manually.');
    }
  }

  async function revoke(code: string) {
    setError(null);
    try {
      await api.del(`/api/servers/${serverId}/invites/${encodeURIComponent(code)}`);
      if (invite?.code === code) setInvite(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function unban(userId: string) {
    setError(null);
    try {
      await api.del(`/api/servers/${serverId}/bans/${encodeURIComponent(userId)}`);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Dialog title="Invites and bans" onClose={onClose}>
      <label>
        Uses
        <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
          <option value={1}>Single use</option>
          <option value={5}>5 people</option>
          <option value={10}>10 people</option>
        </select>
      </label>
      <p className="cw-hint">Invites expire after 7 days.</p>
      {invite && (
        <>
          <div className="cw-invite-code">{invite.code}</div>
          <p className="cw-hint">Expires {new Date(invite.expiresAt).toLocaleString()}</p>
        </>
      )}
      {error && <p className="cw-error" role="alert">{error}</p>}
      <div className="cw-dialog-actions">
        {invite && <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy code'}</button>}
        <button type="button" className="primary" onClick={() => void generate()} disabled={busy}>
          {busy ? 'Generating…' : invite ? 'New invite' : 'Generate invite'}
        </button>
      </div>

      <section className="cw-dialog-section">
        <h3>Active invites</h3>
        {invites.length === 0 && <p className="cw-hint">No active invites.</p>}
        <ul className="cw-invite-list">
          {invites.map((i) => (
            <li key={i.code}>
              <span className="cw-hint">
                {i.uses}/{i.maxUses} used · expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
              <button type="button" onClick={() => void revoke(i.code)}>Revoke</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="cw-dialog-section">
        <h3>Banned people</h3>
        {bans.length === 0 && <p className="cw-hint">Nobody is banned.</p>}
        <ul className="cw-invite-list">
          {bans.map((b) => (
            <li key={b.user.id}>
              <span className="cw-ban-user">
                <Avatar user={b.user} size={24} />
                {b.user.displayName}
              </span>
              <button type="button" onClick={() => void unban(b.user.id)}>Unban</button>
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
