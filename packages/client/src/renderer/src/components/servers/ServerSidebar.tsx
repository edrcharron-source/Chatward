import { useState, type FormEvent } from 'react';
import type { Channel, Server } from '@chatward/shared';
import { LIMITS } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession, type ServerBundle } from '../../state/session';
import Dialog from './Dialog';
import { errorText, firstTextId } from './util';
import './servers.css';

type DialogKind = 'create' | 'join' | null;

export default function ServerSidebar({ onReload }: { onReload: () => Promise<void> }) {
  const servers = useSession((s) => s.servers);
  const activeServerId = useSession((s) => s.activeServerId);
  const [dialog, setDialog] = useState<DialogKind>(null);

  function open(b: ServerBundle) {
    useSession.getState().setActive(b.server.id, firstTextId(b.channels));
  }

  return (
    <nav className="cw-servers" data-region="servers" aria-label="Servers">
      {servers.map((b) => {
        const active = b.server.id === activeServerId;
        return (
          <button
            key={b.server.id}
            type="button"
            className={`cw-server-icon${active ? ' active' : ''}`}
            title={b.server.name}
            aria-label={b.server.name}
            aria-current={active ? 'true' : undefined}
            onClick={() => open(b)}
          >
            {b.server.name.trim().charAt(0).toUpperCase() || '?'}
          </button>
        );
      })}
      <button type="button" className="cw-server-icon add" title="Create server" aria-label="Create server" onClick={() => setDialog('create')}>+</button>
      <button type="button" className="cw-server-icon join" title="Join with invite" aria-label="Join with invite" onClick={() => setDialog('join')}>↪</button>

      {dialog === 'create' && <CreateServerDialog onClose={() => setDialog(null)} onReload={onReload} />}
      {dialog === 'join' && <JoinServerDialog onClose={() => setDialog(null)} onReload={onReload} />}
    </nav>
  );
}

function CreateServerDialog({ onClose, onReload }: { onClose: () => void; onReload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Give your server a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ server: Server; channels: Channel[] }>('/api/servers', { name: trimmed });
      await onReload();
      useSession.getState().setActive(res.server.id, firstTextId(res.channels));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create a server" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Server name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.SERVER_NAME_MAX} autoFocus required />
        </label>
        {error && <p className="cw-error" role="alert">{error}</p>}
        <div className="cw-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function JoinServerDialog({ onClose, onReload }: { onClose: () => void; onReload: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) { setError('Paste an invite code.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ server: Server }>(`/api/invites/${encodeURIComponent(trimmed)}/join`, {});
      await onReload();
      const joined = useSession.getState().servers.find((b) => b.server.id === res.server.id);
      useSession.getState().setActive(res.server.id, firstTextId(joined?.channels ?? []));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Join a server" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Invite code
          <input value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoFocus required />
        </label>
        {error && <p className="cw-error" role="alert">{error}</p>}
        <div className="cw-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Joining…' : 'Join'}</button>
        </div>
      </form>
    </Dialog>
  );
}
