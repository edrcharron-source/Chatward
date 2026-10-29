import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerFrame, VaultDescriptor, VaultItem } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { onKeysChanged } from '../../crypto';
import { useSession } from '../../state/session';
import { fetchVaultUrl, openDescriptor, uploadToVault, type VaultPage } from './vault';
import './vault.css';

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export default function VaultView({ serverId, keyChannelId, canModerate }: { serverId: string; keyChannelId: string | undefined; canModerate: boolean }) {
  const me = useSession((s) => s.user?.id ?? '');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [usage, setUsage] = useState({ used: 0, quota: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState<{ item: VaultItem; d: VaultDescriptor } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = (r: VaultPage, append: boolean) => {
    setItems((cur) => (append ? [...cur, ...r.items.filter((i) => !cur.some((c) => c.id === i.id))] : r.items));
    setHasMore(r.hasMore);
    setUsage({ used: r.usedBytes, quota: r.quotaBytes, max: r.maxBytes });
  };
  const load = useCallback(() => {
    api.get<VaultPage>(`/api/servers/${serverId}/vault`).then((r) => apply(r, false)).catch((e: Error) => setError(e.message));
  }, [serverId]);
  useEffect(() => {
    setItems([]); setError(null); load();
    return onFrame((f: ServerFrame) => {
      if (f.t === 'vault.new' && f.item.serverId === serverId) setItems((l) => (l.some((i) => i.id === f.item.id) ? l : [f.item, ...l]));
      else if (f.t === 'vault.delete' && f.serverId === serverId) setItems((l) => l.filter((i) => i.id !== f.itemId));
    });
  }, [serverId, load]);

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last) return;
    try { apply(await api.get<VaultPage>(`/api/servers/${serverId}/vault?before=${last.createdAt}`), true); }
    catch (e) { setError((e as Error).message); }
  }

  async function upload(files: FileList | null) {
    if (!files?.length || !keyChannelId) return;
    setError(null);
    for (const [i, file] of [...files].entries()) {
      if (usage.max > 0 && file.size > usage.max) { setError(`${file.name} is over the ${mb(usage.max)} limit.`); continue; }
      setStatus(`Encrypting and uploading ${file.name} (${i + 1}/${files.length})…`);
      try {
        const item = await uploadToVault(serverId, keyChannelId, me, file);
        setItems((l) => (l.some((x) => x.id === item.id) ? l : [item, ...l]));
        setUsage((u) => ({ ...u, used: u.used + item.size }));
      } catch (e) { setError((e as Error).message); }
    }
    setStatus(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function remove(item: VaultItem) {
    if (!window.confirm('Delete this from the Vault for everyone?')) return;
    try {
      await api.del(`/api/vault/${item.id}`);
      setItems((l) => l.filter((i) => i.id !== item.id));
      setOpen(null);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="cw-vault" aria-label="Vault">
      <header className="cw-vault-head">
        <h2>Vault</h2>
        <span className="muted">
          {usage.quota > 0 ? `${mb(usage.used)} of ${mb(usage.quota)} used by you` : `${mb(usage.used)} used by you`}
        </span>
        <button type="button" className="primary" disabled={!keyChannelId || status !== null} onClick={() => fileInput.current?.click()}>Add photos or videos</button>
        <input ref={fileInput} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => void upload(e.target.files)} />
      </header>
      {status && <p className="muted">{status}</p>}
      {error && <p className="media-error" role="alert">{error}</p>}
      {!items.length && !error && <p className="muted">Nothing here yet. Add photos or videos and everyone in the server can see them. Everything is encrypted before it leaves your computer.</p>}
      <div className="cw-vault-grid">
        {items.map((item) => <Tile key={item.id} item={item} onOpen={(d) => setOpen({ item, d })} />)}
      </div>
      {hasMore && <button type="button" className="cw-vault-more" onClick={() => void loadMore()}>Load older</button>}
      {open && <Viewer item={open.item} d={open.d} canDelete={open.item.ownerId === me || canModerate} onDelete={() => void remove(open.item)} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Tile({ item, onOpen }: { item: VaultItem; onOpen: (d: VaultDescriptor) => void }) {
  const [d, setD] = useState<VaultDescriptor | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Keys can arrive after the gallery (a new device still syncing), so retry when they do.
  const [tries, setTries] = useState(0);
  useEffect(() => onKeysChanged(() => setTries((n) => n + 1)), []);
  useEffect(() => {
    let alive = true; let made: string | null = null;
    (async () => {
      try {
        const desc = await openDescriptor(item);
        if (!desc) { if (alive) setFailed(true); return; }
        made = await fetchVaultUrl(item, desc, true);
        if (alive) { setD(desc); setUrl(made); setFailed(false); }
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [item, tries]);
  return (
    <button type="button" className="cw-vault-tile" disabled={!d} onClick={() => d && onOpen(d)} title={d?.name}>
      {url ? <img src={url} alt={d?.name ?? ''} /> : <span className="muted">{failed ? 'Locked' : '…'}</span>}
      {d?.kind === 'video' && <span className="cw-vault-badge">▶{d.durationSec ? ` ${Math.floor(d.durationSec / 60)}:${String(d.durationSec % 60).padStart(2, '0')}` : ''}</span>}
    </button>
  );
}

function Viewer({ item, d, canDelete, onDelete, onClose }: { item: VaultItem; d: VaultDescriptor; canDelete: boolean; onDelete: () => void; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true; let made: string | null = null;
    fetchVaultUrl(item, d, false).then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => { if (alive) setFailed(true); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { alive = false; document.removeEventListener('keydown', key); if (made) URL.revokeObjectURL(made); };
  }, [item, d, onClose]);
  return (
    <div className="cw-vault-viewer" role="dialog" aria-label={d.name} onClick={onClose}>
      <div className="cw-vault-stage" onClick={(e) => e.stopPropagation()}>
        {failed ? <p className="media-error">Couldn't load this file.</p>
          : !url ? <p className="muted">Decrypting…</p>
          : d.kind === 'video' ? <video src={url} controls autoPlay />
          : <img src={url} alt={d.name} />}
        <div className="cw-vault-bar">
          <span title={d.name}>{d.name} · {mb(d.size)}</span>
          {url && <a href={url} download={d.name}>Save</a>}
          {canDelete && <button type="button" onClick={onDelete}>Delete</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
