import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerFrame, VaultAlbum, VaultCategory, VaultAnnotation, VaultDescriptor, VaultItem, VaultNotes } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { onKeysChanged } from '../../crypto';
import { sendMessage } from '../../state/chat';
import { useSession } from '../../state/session';
import { buildAlbums } from './albums';
import AlbumStrip, { type AlbumCard } from './AlbumStrip';
import { albumsApi, fetchVaultUrl, fetchVaultViewUrl, openAlbumMeta, mergedNotes, normalizeTag, openDescriptor, openNotes, readForVault, saveNotes, uploadToVault, type NotesByItem, type VaultPage } from './vault';
import { loadVaultIndex } from './vaultIndex';
import { CATEGORY_TAG, categoryOf } from './sort/clues';
import { needsSort, sortItem } from './sort/sorter';
import { canQueueToWatchParty, queueToWatchParty } from '../watchparty/bridge';
import { vaultItem } from '../watchparty/sync';
import { usePhone } from '../../web/usePhone';
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

  // Albums made by hand: stored on the server with sealed names, kept live over the socket.
  const [manual, setManual] = useState<VaultAlbum[]>([]);
  const [albumNames, setAlbumNames] = useState<Record<string, string>>({});
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const putAlbum = useCallback((a: VaultAlbum) => {
    setManual((cur) => [a, ...cur.filter((x) => x.id !== a.id)].sort((x, y) => y.createdAt - x.createdAt));
    void openAlbumMeta(a).then((m) => setAlbumNames((cur) => ({ ...cur, [a.id]: m?.name ?? 'Locked album' })));
  }, []);
  useEffect(() => {
    let alive = true;
    setManual([]);
    albumsApi.list(serverId).then((list) => { if (alive) list.forEach(putAlbum); }).catch(() => {});
    return () => { alive = false; };
  }, [serverId, keyTick, putAlbum]);
  useEffect(() => onFrame((f: ServerFrame) => {
    if (f.t === 'vault.album' && f.album.serverId === serverId) putAlbum(f.album);
    else if (f.t === 'vault.album.delete' && f.serverId === serverId) {
      setManual((cur) => cur.filter((a) => a.id !== f.albumId));
      setFilter((cur) => (cur?.value === `manual:${f.albumId}` ? null : cur));
    } else if (f.t === 'vault.delete' && f.serverId === serverId) {
      setManual((cur) => cur.map((a) => (a.itemIds.includes(f.itemId) ? { ...a, itemIds: a.itemIds.filter((i) => i !== f.itemId), coverItemId: a.coverItemId === f.itemId ? null : a.coverItemId } : a)));
    }
  }), [serverId, putAlbum]);
  // The photo sorter: what each item is, from manual #photo/#meme/#screenshot tags or the on-device sort.
  const catOf = (id: string) => categoryOf(Object.values(notes[id] ?? {}));
  const sortedAlbums = (() => {
    const by: Record<VaultCategory | 'unsorted', string[]> = { meme: [], screenshot: [], photo: [], unsorted: [] };
    for (const i of items) { const c = catOf(i.id); by[c.category ?? 'unsorted'].push(i.id); }
    const anySorted = by.meme.length + by.screenshot.length + by.photo.length > 0;
    return [
      { key: 'sort:meme', label: 'Memes', ids: by.meme },
      { key: 'sort:screenshot', label: 'Screenshots', ids: by.screenshot },
      { key: 'sort:photo', label: 'Real photos', ids: by.photo },
      ...(anySorted ? [{ key: 'sort:unsorted', label: 'Unsorted', ids: by.unsorted }] : []),
    ].filter((a) => a.ids.length);
  })();
  const smartAlbums = [...sortedAlbums, ...(albums.onThisDay ? [albums.onThisDay] : []), ...albums.kinds, ...albums.events, ...albums.people];

  // Sorting the rest of the Vault on this device: items nobody has sorted yet (or only by clues, once the model is here).
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  useEffect(() => { api.get<{ available: boolean }>('/api/vault/sort-model/info').then((r) => setModelReady(r.available)).catch(() => setModelReady(false)); }, [serverId]);
  const toSort = items.filter((i) => descs[i.id] && needsSort(Object.values(notes[i.id] ?? {}).map((n) => n.auto), catOf(i.id).manual, !!modelReady));
  const sortRun = useRef<{ stop: boolean } | null>(null);
  const [sorting, setSorting] = useState<string | null>(null);
  async function sortVault() {
    const run = { stop: false };
    sortRun.current = run;
    const list = [...toSort];
    let done = 0;
    for (const item of list) {
      if (run.stop) break;
      setSorting(`Sorting ${done + 1} of ${list.length}…`);
      try { await sortItem(item, descs[item.id], me, notes[item.id]?.[me], (m) => setSorting(m)); }
      catch (e) { setError(`Sorting stopped: ${(e as Error).message}`); break; }
      done++;
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe between pictures
    }
    sortRun.current = null;
    setSorting(null);
  }
  const activeManual = filter?.kind === 'album' && filter.value.startsWith('manual:') ? manual.find((a) => `manual:${a.id}` === filter.value) : undefined;
  const activeSmart = filter?.kind === 'album' && !activeManual ? smartAlbums.find((a) => a.key === filter.value) : undefined;
  const albumIds = (key: string) => key.startsWith('manual:') ? manual.find((a) => `manual:${a.id}` === key)?.itemIds ?? [] : smartAlbums.find((a) => a.key === key)?.ids ?? [];
  const itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
  const albumCards: AlbumCard[] = [
    ...manual.map((a) => ({ key: `manual:${a.id}`, label: albumNames[a.id] ?? '…', count: a.itemIds.length, coverId: a.coverItemId ?? a.itemIds[0], manual: true })),
    ...smartAlbums.map((a) => ({ key: a.key, label: a.label, count: a.ids.length, coverId: a.ids[0] })),
  ];
  const canManage = (a: VaultAlbum) => a.ownerId === me || canModerate;
  const askName = (start = '') => {
    const name = window.prompt('Album name', start)?.trim();
    return name ? name.slice(0, 80) : null;
  };
  async function newAlbum(ids: string[]) {
    if (!keyChannelId) return;
    const name = askName();
    if (!name) return;
    try {
      const a = await albumsApi.create(serverId, keyChannelId, me, { name }, ids);
      putAlbum(a);
      setFilter({ kind: 'album', value: `manual:${a.id}` });
      setSelecting(false); setSelected(new Set());
    } catch (e) { setError((e as Error).message); }
  }
  async function renameAlbum(a: VaultAlbum) {
    if (!keyChannelId) return;
    const name = askName(albumNames[a.id]);
    if (!name) return;
    try { putAlbum(await albumsApi.rename(a, keyChannelId, me, { name })); } catch (e) { setError((e as Error).message); }
  }
  async function deleteAlbum(a: VaultAlbum) {
    if (!window.confirm(`Delete the album "${albumNames[a.id] ?? ''}"? The photos stay in the Vault.`)) return;
    try { await albumsApi.remove(a.id); setManual((cur) => cur.filter((x) => x.id !== a.id)); setFilter(null); } catch (e) { setError((e as Error).message); }
  }
  async function addToAlbum(albumId: string, ids: string[]) {
    try {
      putAlbum(await albumsApi.change(albumId, ids));
      setStatus(`Added to ${albumNames[albumId] ?? 'the album'}.`);
      setTimeout(() => setStatus((s) => (s?.startsWith('Added to') ? null : s)), 2500);
    } catch (e) { setError((e as Error).message); }
  }
  async function takeOut(a: VaultAlbum, ids: string[]) {
    try { putAlbum(await albumsApi.change(a.id, [], ids)); setSelected(new Set()); } catch (e) { setError((e as Error).message); }
  }
  async function deleteSelected(ids: string[]) {
    const mine = ids.filter((id) => itemsById[id]?.ownerId === me || canModerate);
    if (!mine.length) return;
    if (!window.confirm(`Delete ${mine.length} item${mine.length === 1 ? '' : 's'} from the Vault for everyone?`)) return;
    for (const id of mine) {
      try { await api.del(`/api/vault/${id}`); setItems((l) => l.filter((i) => i.id !== id)); } catch (e) { setError((e as Error).message); break; }
    }
    setSelected(new Set());
  }
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
    if (filter.kind === 'album') return albumIds(filter.value).includes(i.id);
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
        // Adding while an album is open puts the new items in that album too.
        if (activeManual) await albumsApi.change(activeManual.id, [item.id]).then(putAlbum).catch(() => {});
        // Sort it on this device in the background; a failure just leaves it unsorted.
        void openDescriptor(item).then((d) => (d ? sortItem(item, d, me, undefined) : null)).catch(() => {});
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

  // Phones: a long press on a picture starts selecting with that picture picked, like the Photos app.
  const phone = usePhone();
  const startSelecting = (id: string) => { setSelecting(true); setSelected(new Set([id])); };

  return (
    <section className="cw-vault" aria-label="Vault">
      <header className="cw-vault-head">
        <h2>Vault</h2>
        <span className="muted">
          {usage.quota > 0 ? `${mb(usage.used)} of ${mb(usage.quota)} used by you` : `${mb(usage.used)} used by you`}
        </span>
        {sorting
          ? <button type="button" title="Stop sorting" onClick={() => { if (sortRun.current) sortRun.current.stop = true; }}>{sorting} Stop</button>
          : toSort.length > 0 && <button type="button" title="Sort photos into Memes, Screenshots and Real photos on this device. Nothing is sent to the server." onClick={() => void sortVault()}>Sort {toSort.length} into albums</button>}
        {items.length > 0 && <button type="button" aria-pressed={selecting} onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}>{selecting ? 'Done' : 'Select'}</button>}
        <button type="button" className="primary cw-vault-add" disabled={!keyChannelId || (status !== null && !status.startsWith('Added to'))} onClick={() => fileInput.current?.click()}>{phone ? '+ Add' : 'Add photos or videos'}</button>
        <input ref={fileInput} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => void upload(e.target.files)} />
      </header>
      {status && <p className="muted">{status}</p>}
      {error && <p className="media-error" role="alert">{error}</p>}
      {!items.length && !error && <p className="muted">Nothing here yet. Add photos or videos and everyone in the server can see them. Everything is encrypted before it leaves your computer.</p>}
      {(albumCards.length > 0 || items.length > 0) && (
        <AlbumStrip cards={albumCards} items={itemsById} descs={descs}
          active={filter?.kind === 'album' ? filter.value : null}
          onPick={(key) => setFilter(key ? { kind: 'album', value: key } : null)}
          onNew={keyChannelId && items.length ? () => void newAlbum(selecting ? [...selected] : []) : undefined}
          newLabel={selecting && selected.size ? `New album with ${selected.size}` : 'New album'} />
      )}
      {activeManual && (
        <div className="cw-vault-albumbar">
          <strong>{albumNames[activeManual.id] ?? 'Album'}</strong>
          <span className="muted">{activeManual.itemIds.length} item{activeManual.itemIds.length === 1 ? '' : 's'}</span>
          {canManage(activeManual) && <button type="button" onClick={() => void renameAlbum(activeManual)}>Rename</button>}
          {canManage(activeManual) && <button type="button" onClick={() => void deleteAlbum(activeManual)}>Delete album</button>}
          <button type="button" onClick={() => setFilter(null)}>Close</button>
        </div>
      )}
      {activeSmart && (
        <div className="cw-vault-albumbar">
          <strong>{activeSmart.label}</strong>
          <span className="muted">{activeSmart.ids.length} item{activeSmart.ids.length === 1 ? '' : 's'}, picked automatically</span>
          {keyChannelId && <button type="button" title="Keep these as an album you can add to and rename" onClick={() => void newAlbum(activeSmart.ids)}>Save as album</button>}
          <button type="button" onClick={() => setFilter(null)}>Close</button>
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
      {selecting && (
        <div className="cw-vault-selectbar" role="toolbar" aria-label="Selected items">
          <span>{selected.size} selected</span>
          <button type="button" onClick={() => setSelected(new Set(shown.map((i) => i.id)))}>Select all {shown.length}</button>
          {manual.length > 0 && (
            <select aria-label="Add to album" value="" disabled={!selected.size} onChange={(e) => { if (e.target.value) void addToAlbum(e.target.value, [...selected]); }}>
              <option value="">Add to album…</option>
              {manual.map((a) => <option key={a.id} value={a.id}>{albumNames[a.id] ?? '…'}</option>)}
            </select>
          )}
          <button type="button" disabled={!selected.size || !keyChannelId} onClick={() => void newAlbum([...selected])}>New album</button>
          {activeManual && <button type="button" disabled={!selected.size} onClick={() => void takeOut(activeManual, [...selected])}>Take out of album</button>}
          <button type="button" disabled={!selected.size} onClick={() => void deleteSelected([...selected])}>Delete</button>
        </div>
      )}
      <div className="cw-vault-grid">
        {shown.slice(0, visible).map((item) => <Tile key={item.id} item={item} selecting={selecting} selected={selected.has(item.id)} onToggle={() => toggle(item.id)} onOpen={(d) => setOpen({ item, d })} onLongPress={!selecting && phone ? () => startSelecting(item.id) : undefined} />)}
      </div>
      {shown.length > visible && <button type="button" className="cw-vault-more" onClick={() => setVisible((n) => n + TILE_STEP)}>Show more ({shown.length - visible} left)</button>}
      {shown.length <= visible && hasMore && <button type="button" className="cw-vault-more" onClick={() => void loadMore()}>Load older</button>}
      {open && <Viewer item={open.item} d={open.d} canDelete={open.item.ownerId === me || canModerate} onDelete={() => void remove(open.item)} onClose={() => setOpen(null)}
        panel={<NotesEditor item={open.item} me={me} mine={notes[open.item.id]?.[me]} merged={mergedNotes(notes[open.item.id])} people={people} onError={setError} sorted={catOf(open.item.id)} />}
        extra={<>
          {open.d.kind === 'video' && canQueueToWatchParty() && <button type="button" title="Queue this for everyone in your call" onClick={() => watchTogether(open.item, open.d)}>Watch together</button>}
          {chatChannelId && <button type="button" disabled={sending} onClick={() => void sendToChat(open.item, open.d)}>{sending ? 'Sending…' : 'Send to chat'}</button>}
          {manual.length > 0 && (
            <select aria-label="Add to album" value="" onChange={(e) => { if (e.target.value) void addToAlbum(e.target.value, [open.item.id]); }}>
              <option value="">Add to album…</option>
              {manual.filter((a) => !a.itemIds.includes(open.item.id)).map((a) => <option key={a.id} value={a.id}>{albumNames[a.id] ?? '…'}</option>)}
            </select>
          )}
          {activeManual?.itemIds.includes(open.item.id) && canManage(activeManual) && <button type="button" title="Use this as the album's cover" onClick={() => void albumsApi.setCover(activeManual.id, open.item.id).then(putAlbum).catch((e: Error) => setError(e.message))}>Make cover</button>}
        </>} />}
    </section>
  );
}

function Tile({ item, onOpen, selecting = false, selected = false, onToggle, onLongPress }: { item: VaultItem; onOpen: (d: VaultDescriptor) => void; selecting?: boolean; selected?: boolean; onToggle?: () => void; onLongPress?: () => void }) {
  const [d, setD] = useState<VaultDescriptor | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => cancelPress, []);
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
    <button type="button" className={`cw-vault-tile${selected ? ' selected' : ''}`} disabled={!d && !selecting} aria-pressed={selecting ? selected : undefined}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType !== 'touch' || !onLongPress) return;
        const { clientX: x, clientY: y } = e;
        press.current = { x, y, timer: setTimeout(() => { press.current = null; longPressed.current = true; navigator.vibrate?.(10); onLongPress(); }, 450) };
      }}
      onPointerMove={(e) => { if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancelPress(); }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress}
      onContextMenu={(e) => { if (onLongPress || longPressed.current) e.preventDefault(); }}
      onClick={() => { if (longPressed.current) { longPressed.current = false; return; } if (selecting) onToggle?.(); else if (d) onOpen(d); }} title={d?.name}>
      {url ? <img src={url} alt={d?.name ?? ''} /> : <span className="muted">{failed ? 'Locked' : '…'}</span>}
      {selecting && <span className="cw-vault-check" aria-hidden="true">{selected ? '✓' : ''}</span>}
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

function NotesEditor({ item, me, mine, merged, people, onError, sorted }: {
  item: VaultItem; me: string; mine: VaultNotes | undefined; merged: { tags: string[]; people: string[] };
  people: { id: string; name: string }[]; onError: (m: string) => void;
  sorted: { category: VaultCategory | null; manual: boolean; score?: number; sorted: boolean };
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
  // Picking a category is a tag of mine, which beats the automatic sort for everyone. Picking it again takes it back.
  const categoryTags = Object.values(CATEGORY_TAG);
  const pick = (c: VaultCategory) => {
    const mineNow = cur.tags.includes(CATEGORY_TAG[c]);
    void save({ ...cur, tags: [...cur.tags.filter((t) => !categoryTags.includes(t)), ...(mineNow ? [] : [CATEGORY_TAG[c]])] });
  };
  return (
    <div className="cw-vault-notes" onClick={(e) => e.stopPropagation()}>
      <div className="cw-vault-chips" role="group" aria-label="What this is">
        <span className="muted">{sorted.category ? (sorted.manual ? 'Sorted as:' : `Sorted as (auto${sorted.score ? `, ${Math.round(sorted.score * 100)}%` : ''}):`) : sorted.sorted ? 'Not sure what this is:' : 'Not sorted yet:'}</span>
        {(['photo', 'meme', 'screenshot'] as VaultCategory[]).map((c) => (
          <button key={c} type="button" className={sorted.category === c ? 'on' : ''} aria-pressed={cur.tags.includes(CATEGORY_TAG[c])} onClick={() => pick(c)}>
            {c === 'photo' ? 'Real photo' : c === 'meme' ? 'Meme' : 'Screenshot'}
          </button>
        ))}
      </div>
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
