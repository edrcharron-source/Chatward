import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerFrame, VaultAnnotation, VaultDescriptor, VaultItem, VaultNotes } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { onKeysChanged } from '../../crypto';
import { sendMessage } from '../../state/chat';
import { useSession } from '../../state/session';
import { buildAlbums } from './albums';
import { fetchVaultUrl, fetchVaultViewUrl, mergedNotes, normalizeTag, openDescriptor, openNotes, readForVault, saveNotes, uploadToVault, type NotesByItem, type VaultPage } from './vault';
import { loadVaultIndex } from './vaultIndex';
import { canQueueToWatchParty, queueToWatchParty } from '../watchparty/bridge';
import { vaultItem } from '../watchparty/sync';
import './vault.css';

/** Tiles drawn at first and added per "Show more"; albums and filters still cover the whole Vault. */
const TILE_STEP = 120;

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export default function VaultView({ serverId, keyChannelId, canModerate, chatChannelId, people = [] }: { serverId: string; keyChannelId: string | undefined; canModerate: boolean; chatChannelId?: string; people?: { id: string; name: string }[] }) {
  const me = useSession((s) => s.user?.id ?? '');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [visible, setVisible] = useState(TILE_STEP);
  const [usage, setUsage] = useState({ used: 0, quota: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState<{ item: VaultItem; d: VaultDescriptor } | null>(null);
  const [notes, setNotes] = useState<NotesByItem>({});
  const [keyTick, setKeyTick] = useState(0);
  useEffect(() => onKeysChanged(() => setKeyTick((n) => n + 1)), []);
  const [filter, setFilter] = useState<{ kind: 'tag' | 'person' | 'album'; value: string } | null>(null);
  const [descs, setDescs] = useState<Record<string, VaultDescriptor>>({});
  useEffect(() => {
    let alive = true;
    for (const item of items) {
      if (descs[item.id]) continue;
      void openDescriptor(item).then((d) => { if (alive && d) setDescs((cur) => (cur[item.id] ? cur : { ...cur, [item.id]: d })); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [items, keyTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const albums = buildAlbums(items.map((item) => ({ item, d: descs[item.id] })), (id) => people.find((p) => p.id === id)?.name ?? 'someone');
  const putNotes = useCallback(async (a: VaultAnnotation) => {
    const n = await openNotes(a);
    setNotes((cur) => {
      const by = { ...(cur[a.itemId] ?? {}) };
      if (n) by[a.authorId] = n; else delete by[a.authorId];
      return { ...cur, [a.itemId]: by };
    });
  }, []);
  useEffect(() => {
    let alive = true;
    api.get<{ annotations: VaultAnnotation[] }>(`/api/servers/${serverId}/vault/annotations`)
      .then((r) => { if (alive) r.annotations.forEach((a) => void putNotes(a)); }).catch(() => {});
    return () => { alive = false; };
  }, [serverId, keyTick, putNotes]);
  useEffect(() => onFrame((f: ServerFrame) => {
    if (f.t === 'vault.annotation' && f.annotation.serverId === serverId) void putNotes(f.annotation);
    else if (f.t === 'vault.annotation.delete' && f.serverId === serverId) {
      setNotes((cur) => { const by = { ...(cur[f.itemId] ?? {}) }; delete by[f.authorId]; return { ...cur, [f.itemId]: by }; });
    }
  }), [serverId, putNotes]);
  const allTags = (() => {
    const counts = new Map<string, number>();
    for (const by of Object.values(notes)) for (const t of mergedNotes(by).tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  })();
  const taggedPeople = [...new Set(Object.values(notes).flatMap((by) => mergedNotes(by).people))];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone';
  const shown = !filter ? items : items.filter((i) => {
    if (filter.kind === 'album') return [...albums.events, ...albums.people, ...albums.kinds].find((a) => a.key === filter.value)?.ids.includes(i.id) ?? false;
    const m = mergedNotes(notes[i.id]);
    return filter.kind === 'tag' ? m.tags.includes(filter.value) : m.people.includes(filter.value);
  });
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = (r: VaultPage, append: boolean) => {
    setItems((cur) => (append ? [...cur, ...r.items.filter((i) => !cur.some((c) => c.id === i.id))] : r.items));
    setHasMore(r.hasMore);
    setUsage({ used: r.usedBytes, quota: r.quotaBytes, max: r.maxBytes });
  };
  // The whole Vault at once from the index (cached on this device), or page by page from servers without one.
  const load = useCallback(() => {
    loadVaultIndex(serverId)
      .then((r) => r ? apply({ items: r.items, hasMore: false, usedBytes: r.usedBytes, quotaBytes: r.quotaBytes, maxBytes: r.maxBytes }, false)
        : api.get<VaultPage>(`/api/servers/${serverId}/vault`).then((p) => apply(p, false)))
      .catch((e: Error) => setError(e.message));
  }, [serverId]);
  useEffect(() => {
    setItems([]); setError(null); setVisible(TILE_STEP); load();
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
      const label = `${file.name} (${i + 1}/${files.length})`;
      setStatus(`Reading ${label}…`);
      try {
        const ready = await readForVault(file);
        const twin = items.find((it) => descs[it.id]?.sha256 === ready.sha256);
        if (twin && !window.confirm(`${file.name} is already in the Vault. Add it again?`)) continue;
        const item = await uploadToVault(serverId, keyChannelId, me, file, {
          ready,
          onProgress: (sent, total) => setStatus(`Encrypting and uploading ${label}… ${total ? Math.floor((sent / total) * 100) : 0}%`),
        });
        setItems((l) => (l.some((x) => x.id === item.id) ? l : [item, ...l]));
        setUsage((u) => ({ ...u, used: u.used + item.size }));
      } catch (e) { setError((e as Error).message); }
    }
    setStatus(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  const [sending, setSending] = useState(false);
  async function sendToChat(item: VaultItem, d: VaultDescriptor) {
    if (!chatChannelId) return;
    setSending(true); setError(null);
    try { await sendMessage(chatChannelId, { text: '', files: [], vault: [{ ...d, itemId: item.id }] }); setOpen(null); setStatus('Sent to chat.'); }
    catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }

  /** Adds the video to the call's Watch together queue (or starts it), the same as picking it there. */
  function watchTogether(item: VaultItem, d: VaultDescriptor) {
    if (queueToWatchParty(vaultItem({ id: item.id, key: d.key, iv: d.iv, mime: d.mime }, d.name))) { setOpen(null); setStatus('Added to Watch together.'); }
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
      {(albums.events.length + albums.people.length + albums.kinds.length > 0) && (
        <div className="cw-vault-filters" role="group" aria-label="Albums">
          <span className="muted">Albums:</span>
          {[...albums.kinds, ...albums.events, ...albums.people].map((a) => (
            <button key={a.key} type="button" className={filter?.kind === 'album' && filter.value === a.key ? 'on' : ''} onClick={() => setFilter(filter?.value === a.key ? null : { kind: 'album', value: a.key })}>{a.label} {a.ids.length}</button>
          ))}
        </div>
      )}
      {(allTags.length > 0 || taggedPeople.length > 0) && (
        <div className="cw-vault-filters" role="group" aria-label="Filter by tag">
          <button type="button" className={!filter ? 'on' : ''} onClick={() => setFilter(null)}>All</button>
          {allTags.map(([t, n]) => (
            <button key={t} type="button" className={filter?.kind === 'tag' && filter.value === t ? 'on' : ''} onClick={() => setFilter({ kind: 'tag', value: t })}>#{t} {n}</button>
          ))}
          {taggedPeople.map((p) => (
            <button key={p} type="button" className={filter?.kind === 'person' && filter.value === p ? 'on' : ''} onClick={() => setFilter({ kind: 'person', value: p })}>@{nameOf(p)}</button>
          ))}
        </div>
      )}
      <div className="cw-vault-grid">
        {shown.slice(0, visible).map((item) => <Tile key={item.id} item={item} onOpen={(d) => setOpen({ item, d })} />)}
      </div>
      {shown.length > visible && <button type="button" className="cw-vault-more" onClick={() => setVisible((n) => n + TILE_STEP)}>Show more ({shown.length - visible} left)</button>}
      {shown.length <= visible && hasMore && <button type="button" className="cw-vault-more" onClick={() => void loadMore()}>Load older</button>}
      {open && <Viewer item={open.item} d={open.d} canDelete={open.item.ownerId === me || canModerate} onDelete={() => void remove(open.item)} onClose={() => setOpen(null)}
        panel={<NotesEditor item={open.item} me={me} mine={notes[open.item.id]?.[me]} merged={mergedNotes(notes[open.item.id])} people={people} onError={setError} />}
        extra={<>
          {open.d.kind === 'video' && canQueueToWatchParty() && <button type="button" title="Queue this for everyone in your call" onClick={() => watchTogether(open.item, open.d)}>Watch together</button>}
          {chatChannelId && <button type="button" disabled={sending} onClick={() => void sendToChat(open.item, open.d)}>{sending ? 'Sending…' : 'Send to chat'}</button>}
        </>} />}
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

export function Viewer({ item, d, canDelete, onDelete, onClose, extra, panel }: { item: Pick<VaultItem, 'id'>; d: VaultDescriptor; canDelete: boolean; onDelete: () => void; onClose: () => void; extra?: React.ReactNode; panel?: React.ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [isOriginal, setIsOriginal] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true; let made: string | null = null;
    fetchVaultViewUrl(item, d).then((v) => { made = v.url; if (alive) { setUrl(v.url); setIsOriginal(v.original); } else URL.revokeObjectURL(v.url); }).catch(() => { if (alive) setFailed(true); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { alive = false; document.removeEventListener('keydown', key); if (made) URL.revokeObjectURL(made); };
  }, [item, d, onClose]);
  // The viewer shows the lighter preview, so Save fetches the full original first.
  async function saveOriginal() {
    setSaving(true);
    try {
      const full = await fetchVaultUrl(item, d, false);
      const a = document.createElement('a');
      a.href = full; a.download = d.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(full), 60_000);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return (
    <div className="cw-vault-viewer" role="dialog" aria-label={d.name} onClick={onClose}>
      <div className="cw-vault-stage" onClick={(e) => e.stopPropagation()}>
        {failed ? <p className="media-error">Couldn't load this file.</p>
          : !url ? <p className="muted">Decrypting…</p>
          : d.kind === 'video' ? <video src={url} controls autoPlay />
          : <img src={url} alt={d.name} />}
        <div className="cw-vault-bar">
          <span title={d.name}>{d.name} · {mb(d.size)}</span>
          {extra}
          {url && isOriginal && <a href={url} download={d.name}>Save</a>}
          {url && !isOriginal && <button type="button" disabled={saving} title="Downloads the full-size original" onClick={() => void saveOriginal()}>{saving ? 'Saving…' : 'Save'}</button>}
          {canDelete && <button type="button" onClick={onDelete}>Delete</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
        {panel}
      </div>
    </div>
  );
}

function NotesEditor({ item, me, mine, merged, people, onError }: {
  item: VaultItem; me: string; mine: VaultNotes | undefined; merged: { tags: string[]; people: string[] };
  people: { id: string; name: string }[]; onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const save = (next: VaultNotes) => saveNotes(item, me, next).catch((e: Error) => onError(e.message));
  const cur: VaultNotes = mine ?? { tags: [], people: [] };
  const addTags = () => {
    const add = draft.split(',').map(normalizeTag).filter(Boolean);
    setDraft('');
    if (add.length) void save({ ...cur, tags: [...new Set([...cur.tags, ...add])].slice(0, 20) });
  };
  const togglePerson = (id: string) =>
    void save({ ...cur, people: cur.people.includes(id) ? cur.people.filter((p) => p !== id) : [...cur.people, id] });
  const others = merged.tags.filter((t) => !cur.tags.includes(t));
  return (
    <div className="cw-vault-notes" onClick={(e) => e.stopPropagation()}>
      <div className="cw-vault-chips">
        {cur.tags.map((t) => <button key={t} type="button" title="Remove your tag" onClick={() => void save({ ...cur, tags: cur.tags.filter((x) => x !== t) })}>#{t} ×</button>)}
        {others.map((t) => <span key={t} className="muted">#{t}</span>)}
        <input value={draft} placeholder="Add tags, comma separated" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTags(); } }} onBlur={addTags} />
      </div>
      {people.length > 0 && (
        <div className="cw-vault-chips" role="group" aria-label="Who is in this">
          <span className="muted">Who's in it:</span>
          {people.map((p) => (
            <button key={p.id} type="button" className={merged.people.includes(p.id) ? 'on' : ''} aria-pressed={cur.people.includes(p.id)} onClick={() => togglePerson(p.id)}>{p.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}
