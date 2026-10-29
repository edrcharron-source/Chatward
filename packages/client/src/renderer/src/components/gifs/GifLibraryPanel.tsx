import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { LibraryGif } from '@chatward/shared';
import { useSession } from '../../state/session';
import type { Gif } from '../../state/chat';
import {
  countLibraryGifUse, deleteLibraryGif, libraryOf, loadGifLibrary, matchesSearch, updateLibraryGif, useGifLibrary,
} from '../../state/gifLibrary';
import AddGifsDialog from './AddGifsDialog';
import GifDetailsDialog from './GifDetailsDialog';
import GifMakerDialog from './GifMakerDialog';
import LibraryGifImage from './LibraryGifImage';
import './gifs.css';

type Sort = 'newest' | 'used';

/** The picker's Server tab: the server's shared GIF library. Search, sort, add by drop or file picker, make from video. */
export default function GifLibraryPanel({ serverId, onPick }: { serverId: string; onPick: (gif: Gif) => void }) {
  const lib = useGifLibrary((s) => libraryOf(s, serverId));
  const me = useSession((s) => s.user);
  const myRole = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members.find((m) => m.user.id === s.user?.id)?.role);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding] = useState<File[] | null>(null);
  const [making, setMaking] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [menu, setMenu] = useState<{ gif: LibraryGif; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<LibraryGif | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadGifLibrary(serverId); }, [serverId]);

  const canChange = (g: LibraryGif) => g.ownerId === me?.id || myRole === 'owner' || myRole === 'admin';
  const shown = lib.gifs
    .filter((g) => matchesSearch(g, query))
    .sort((a, b) => (sort === 'used' ? b.uses - a.uses : 0) || b.createdAt - a.createdAt);

  const pick = (g: LibraryGif) => {
    countLibraryGifUse(g);
    onPick({ url: '', previewUrl: '', title: g.name, provider: 'library', libraryId: g.id });
  };

  const openMenu = (e: MouseEvent, gif: LibraryGif) => {
    if (!canChange(gif)) return;
    e.preventDefault();
    const box = panelRef.current?.getBoundingClientRect();
    setMenu({ gif, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
  };

  const remove = async (gif: LibraryGif) => {
    setMenu(null);
    if (!window.confirm(`Delete "${gif.name}" from the server's GIFs for everyone?`)) return;
    setError(null);
    try { await deleteLibraryGif(gif); } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete it.'); }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) setAdding(files);
  };

  return (
    <div
      ref={panelRef}
      className={`gif-library${dragging ? ' gif-library-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
      onClick={() => { setMenu(null); setAddMenu(false); }}
    >
      <div className="gif-library-bar">
        <input
          type="search"
          className="media-search gif-library-search"
          placeholder="Search names and tags"
          aria-label="Search the server's GIFs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="gif-add-anchor">
          <button type="button" className="primary gif-add-btn" aria-haspopup="menu" aria-expanded={addMenu}
            onClick={(e) => { e.stopPropagation(); setAddMenu(!addMenu); }}>
            + Add GIF
          </button>
          {addMenu && (
            <div className="gif-menu gif-add-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAddMenu(false); fileRef.current?.click(); }}>Upload GIF files</button>
              <button type="button" role="menuitem" onClick={() => { setAddMenu(false); setMaking(true); }}>Make from video</button>
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/gif"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) setAdding(files);
          }}
        />
      </div>
      <div className="gif-library-sort">
        <label className="muted">
          Sort{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort GIFs">
            <option value="newest">Newest</option>
            <option value="used">Most used</option>
          </select>
        </label>
        <span className="muted">{lib.gifs.length} GIF{lib.gifs.length === 1 ? '' : 's'}</span>
      </div>
      {lib.error && <p className="media-error">{lib.error}</p>}
      {error && <p className="media-error">{error}</p>}
      <div className="media-gif-grid gif-library-grid">
        {shown.map((g) => (
          <button
            key={g.id}
            type="button"
            className="media-gif-tile gif-library-tile"
            title={g.tags.length ? `${g.name} (${g.tags.join(', ')})` : g.name}
            onClick={() => pick(g)}
            onContextMenu={(e) => openMenu(e, g)}
          >
            <LibraryGifImage id={g.id} title={g.name} />
            <span className="gif-tile-name">{g.name}</span>
          </button>
        ))}
      </div>
      {lib.loaded && lib.gifs.length === 0 && (
        <p className="muted media-note">No GIFs yet. Drag GIF files here, or use + Add GIF.</p>
      )}
      {lib.loaded && lib.gifs.length > 0 && shown.length === 0 && <p className="muted media-note">No GIFs match that search.</p>}
      {!lib.loaded && !lib.error && <p className="muted media-note">Loading…</p>}
      <p className="muted gif-drop-hint">Drag and drop .gif files here to add them</p>

      {menu && (
        <div className="gif-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setEditing(menu.gif); setMenu(null); }}>Rename</button>
          <button type="button" role="menuitem" className="gif-menu-danger" onClick={() => void remove(menu.gif)}>Delete</button>
        </div>
      )}
      {dragging && <div className="gif-drop-overlay">Drop to add to the server's GIFs</div>}
      {adding && <AddGifsDialog serverId={serverId} files={adding} onClose={() => setAdding(null)} />}
      {making && <GifMakerDialog serverId={serverId} onClose={() => setMaking(false)} onSend={(g) => { setMaking(false); pick(g); }} />}
      {editing && (
        <GifDetailsDialog
          title="Rename GIF"
          preview={<LibraryGifImage id={editing.id} title={editing.name} className="gif-dialog-img" />}
          initialName={editing.name}
          initialTags={editing.tags}
          submitLabel="Save"
          onSubmit={async (name, tags) => { await updateLibraryGif(editing, name, tags); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
