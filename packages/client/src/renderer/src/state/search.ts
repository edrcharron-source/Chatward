// Chat search. Messages are end-to-end encrypted, so the server cannot search them: the app reads a channel's whole
// history page by page, decrypts it here and searches that. The decrypted index lives in memory only, never on disk,
// and is dropped on sign out and after a reconnect (when messages may have been deleted while we were away).
import { create } from 'zustand';
import { LIMITS, type Message } from '@chatward/shared';
import { api } from '../api/http';
import { onFrame } from '../api/ws';
import { decryptMessage, onKeysChanged } from '../crypto';
import { isLiveChannel, onBeforeSignOut, useSession } from './session';
import type { SearchEntry, SearchFilters } from './searchMatch';

export interface IndexStatus {
  /** Messages read so far. */
  scanned: number;
  /** The whole history has been read. */
  complete: boolean;
  building: boolean;
  error: string | null;
  /** Bumped on every change to the index, so views know to search again. */
  version: number;
}

interface SearchState {
  /** channelId -> the open search box's filters. A channel without an entry has its search closed. */
  panels: Record<string, SearchFilters>;
  status: Record<string, IndexStatus>;
  /** A message to scroll to and highlight. `seq` makes clicking the same result twice jump twice. */
  jump: { channelId: string; messageId: string; createdAt: number; seq: number } | null;
}

export const EMPTY_FILTERS: SearchFilters = { text: '', authorId: '', kind: 'any' };
const NO_STATUS: IndexStatus = { scanned: 0, complete: false, building: false, error: null, version: 0 };

export const useSearch = create<SearchState>(() => ({ panels: {}, status: {}, jump: null }));

/** channelId -> messageId -> entry. Kept out of the store so a page of 50 does not copy thousands of entries. */
const indexes = new Map<string, Map<string, SearchEntry>>();
/** Bumped when indexes are dropped, so a build still running for an old index stops writing. */
let generation = 0;

export const statusOf = (channelId: string) => useSearch.getState().status[channelId] ?? NO_STATUS;

function patchStatus(channelId: string, patch: Partial<IndexStatus>) {
  useSearch.setState((s) => {
    const cur = s.status[channelId] ?? NO_STATUS;
    return { status: { ...s.status, [channelId]: { ...cur, ...patch, version: cur.version + 1 } } };
  });
}

export function openSearch(channelId: string) {
  useSearch.setState((s) => (s.panels[channelId] ? {} : { panels: { ...s.panels, [channelId]: EMPTY_FILTERS } }));
  void buildIndex(channelId);
}

export function closeSearch(channelId: string) {
  useSearch.setState((s) => {
    const panels = { ...s.panels };
    delete panels[channelId];
    return { panels };
  });
}

export function setFilters(channelId: string, patch: Partial<SearchFilters>) {
  useSearch.setState((s) => ({ panels: { ...s.panels, [channelId]: { ...(s.panels[channelId] ?? EMPTY_FILTERS), ...patch } } }));
}

let jumpSeq = 0;
export function jumpTo(message: Message) {
  useSearch.setState({ jump: { channelId: message.channelId, messageId: message.id, createdAt: message.createdAt, seq: ++jumpSeq } });
}

export function clearJump(seq: number) {
  if (useSearch.getState().jump?.seq === seq) useSearch.setState({ jump: null });
}

/** The index's entries for a channel. Callers add what the chat itself holds, which is fresher. */
export function indexedEntries(channelId: string): Iterable<SearchEntry> {
  return indexes.get(channelId)?.values() ?? [];
}

async function decryptInto(channelId: string, index: Map<string, SearchEntry>, messages: Message[]) {
  const results = await Promise.all(messages.map(async (m) => ({ message: m, payload: await decryptMessage(m).catch(() => null) })));
  for (const e of results) {
    const held = index.get(e.message.id);
    // A newer copy (an edit) that arrived meanwhile wins over this one.
    if (held && (held.message.editedAt ?? 0) > (e.message.editedAt ?? 0)) continue;
    index.set(e.message.id, e);
  }
}

/**
 * Reads the channel's history from the newest message back to the first, a page at a time, decrypting as it goes.
 * Results show while it runs. A build that failed is picked up from where it stopped by the next call.
 */
export async function buildIndex(channelId: string) {
  const st = statusOf(channelId);
  if (st.building || st.complete) return;
  const gen = generation;
  let index = indexes.get(channelId);
  if (!index) indexes.set(channelId, (index = new Map()));
  const stillWanted = () => gen === generation && isLiveChannel(channelId) && indexes.get(channelId) === index;

  patchStatus(channelId, { building: true, error: null });
  try {
    for (;;) {
      // The oldest message read so far is where the next page starts.
      let oldest: Message | undefined;
      for (const e of index.values()) if (!oldest || e.message.createdAt < oldest.createdAt) oldest = e.message;
      const before = oldest ? `&before=${oldest.id}` : '';
      const { messages } = await api.get<{ messages: Message[] }>(
        `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}${before}`,
      );
      if (!stillWanted()) return;
      await decryptInto(channelId, index, messages);
      if (!stillWanted()) return;
      const complete = messages.length < LIMITS.HISTORY_PAGE;
      patchStatus(channelId, { scanned: index.size, complete });
      if (complete) break;
    }
    patchStatus(channelId, { building: false });
  } catch (e) {
    if (stillWanted()) patchStatus(channelId, { building: false, error: e instanceof Error ? e.message : 'Could not read the history' });
  }
}

function dropIndexes() {
  generation++;
  indexes.clear();
  // Open search boxes stay open and read the history again.
  const open = Object.keys(useSearch.getState().panels);
  useSearch.setState({ status: {} });
  for (const id of open) if (isLiveChannel(id)) void buildIndex(id);
}

function clearSearch() {
  generation++;
  indexes.clear();
  useSearch.setState({ panels: {}, status: {}, jump: null });
}

// The next person on this computer must never find the previous account's messages.
onBeforeSignOut(clearSearch);
useSession.subscribe((s, prev) => {
  if (prev.token && !s.token) clearSearch();
});

onFrame((f) => {
  switch (f.t) {
    case 'message.new': {
      const index = indexes.get(f.message.channelId);
      if (index) void decryptInto(f.message.channelId, index, [f.message]).then(() => patchStatus(f.message.channelId, {}));
      return;
    }
    case 'message.edit': {
      const index = indexes.get(f.message.channelId);
      if (index?.has(f.message.id)) void decryptInto(f.message.channelId, index, [f.message]).then(() => patchStatus(f.message.channelId, {}));
      return;
    }
    case 'message.delete':
      if (indexes.get(f.channelId)?.delete(f.messageId)) patchStatus(f.channelId, {});
      return;
    case 'ready':
      // Messages deleted or edited while we were away are not in any frame, so read the history again.
      if (indexes.size) dropIndexes();
      return;
  }
});

// Messages that could not be decrypted before a channel key arrived get another try.
onKeysChanged(() => {
  for (const [channelId, index] of indexes) {
    const pending = [...index.values()].filter((e) => !e.payload).map((e) => e.message);
    if (pending.length) void decryptInto(channelId, index, pending).then(() => patchStatus(channelId, {}));
  }
});
