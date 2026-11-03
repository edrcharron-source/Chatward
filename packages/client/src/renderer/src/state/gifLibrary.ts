import { create } from 'zustand';
import type { LibraryGif } from '@chatward/shared';
import { api } from '../api/http';
import { onFrame } from '../api/ws';
import { onBeforeSignOut } from './session';

interface ServerLibrary {
  gifs: LibraryGif[];
  loaded: boolean;
  error: string | null;
}

interface GifLibraryState {
  servers: Record<string, ServerLibrary>;
}

const EMPTY: ServerLibrary = { gifs: [], loaded: false, error: null };

export const useGifLibrary = create<GifLibraryState>(() => ({ servers: {} }));

const patch = (serverId: string, f: (lib: ServerLibrary) => Partial<ServerLibrary>) =>
  useGifLibrary.setState((s) => {
    const lib = s.servers[serverId] ?? EMPTY;
    return { servers: { ...s.servers, [serverId]: { ...lib, ...f(lib) } } };
  });

const upsert = (gif: LibraryGif) =>
  patch(gif.serverId, (lib) => ({
    gifs: lib.gifs.some((g) => g.id === gif.id) ? lib.gifs.map((g) => (g.id === gif.id ? gif : g)) : [gif, ...lib.gifs],
  }));

onFrame((f) => {
  if (f.t === 'gif.new' || f.t === 'gif.update') upsert(f.gif);
  else if (f.t === 'gif.delete') {
    patch(f.serverId, (lib) => ({ gifs: lib.gifs.filter((g) => g.id !== f.gifId) }));
    forgetLibraryGifUrl(f.gifId);
  }
});

/** Loads (or reloads) a server's GIF library. */
export async function loadGifLibrary(serverId: string): Promise<void> {
  try {
    const { gifs } = await api.get<{ gifs: LibraryGif[] }>(`/api/servers/${serverId}/library-gifs`);
    patch(serverId, () => ({ gifs, loaded: true, error: null }));
  } catch (err) {
    patch(serverId, () => ({ error: err instanceof Error ? err.message : 'Could not load the GIF library' }));
  }
}

/** Builds the query string the upload routes take. */
const nameQuery = (name: string, tags: string[]) => new URLSearchParams({ name, tags: tags.join(',') });

/** Adds GIF bytes to the library. Throws with the server's plain-words reason when it is refused. */
export async function addLibraryGif(serverId: string, bytes: BlobPart, name: string, tags: string[]): Promise<LibraryGif> {
  const body = new Blob([bytes], { type: 'image/gif' });
  const { gif } = await api.putRaw<{ gif: LibraryGif }>('POST', `/api/servers/${serverId}/library-gifs?${nameQuery(name, tags)}`, body, 'image/gif');
  upsert(gif);
  return gif;
}

/** Saves a KLIPY GIF into the library; the server downloads it. */
export async function addLibraryGifFromUrl(serverId: string, url: string, name: string, tags: string[]): Promise<LibraryGif> {
  const { gif } = await api.post<{ gif: LibraryGif }>(`/api/servers/${serverId}/library-gifs/from-url?${nameQuery(name, tags)}`, { url });
  upsert(gif);
  return gif;
}

export async function updateLibraryGif(gif: LibraryGif, name: string, tags: string[]): Promise<void> {
  const { gif: updated } = await api.patch<{ gif: LibraryGif }>(`/api/library-gifs/${gif.id}`, { name, tags });
  upsert(updated);
}

export async function deleteLibraryGif(gif: LibraryGif): Promise<void> {
  await api.del(`/api/library-gifs/${gif.id}`);
  patch(gif.serverId, (lib) => ({ gifs: lib.gifs.filter((g) => g.id !== gif.id) }));
  forgetLibraryGifUrl(gif.id);
}

/** Counts a pick toward "Most used". Best effort. */
export function countLibraryGifUse(gif: LibraryGif): void {
  patch(gif.serverId, (lib) => ({ gifs: lib.gifs.map((g) => (g.id === gif.id ? { ...g, uses: g.uses + 1 } : g)) }));
  api.post(`/api/library-gifs/${gif.id}/use`).catch(() => {});
}

// The file needs the auth header, so it is fetched once and shown through an object URL kept for the session.
const urls = new Map<string, Promise<string>>();

/** An object URL for a library GIF's file. Rejects when the GIF is gone. */
export function libraryGifUrl(id: string): Promise<string> {
  let url = urls.get(id);
  if (!url) {
    url = api.getBytes(`/api/library-gifs/${id}/file`).then((buf) => URL.createObjectURL(new Blob([buf], { type: 'image/gif' })));
    // A failure is not kept, so a later look can try again.
    url.catch(() => urls.delete(id));
    urls.set(id, url);
  }
  return url;
}

// Another account may sign in next, so nothing from this one is kept.
onBeforeSignOut(() => {
  for (const id of [...urls.keys()]) forgetLibraryGifUrl(id);
  useGifLibrary.setState({ servers: {} });
});

function forgetLibraryGifUrl(id: string): void {
  const url = urls.get(id);
  if (!url) return;
  urls.delete(id);
  url.then((u) => URL.revokeObjectURL(u), () => {});
}

/** Splits what someone typed into tags: commas separate them. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))];
}

/** Matches a search against a GIF's name and tags; every word must appear somewhere. */
export function matchesSearch(gif: LibraryGif, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${gif.name} ${gif.tags.join(' ')}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export const libraryOf = (s: GifLibraryState, serverId: string): ServerLibrary => s.servers[serverId] ?? EMPTY;
