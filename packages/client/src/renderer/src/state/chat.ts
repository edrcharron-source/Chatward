import { create } from 'zustand';
import { LIMITS, type Attachment, type Message, type MessagePayload } from '@chatward/shared';
import { ApiError, api } from '../api/http';
import { onFrame, sendFrame } from '../api/ws';
import { buildLinkPreviews, extractUrls, shrinkPreviewImage, uploadAttachment } from '../components/media';
import { decryptMessage, encryptPayload, onKeysChanged } from '../crypto';
import { fitPayload } from './fitPayload';
import { isLiveChannel, onBeforeSignOut, refreshUnread, useSession } from './session';

export type Gif = NonNullable<MessagePayload['gif']>;

export interface ChannelChat {
  /** Oldest first. */
  messages: Message[];
  loaded: boolean;
  hasMore: boolean;
  /** A page load or catch-up is running. */
  loading: boolean;
  /** Why the last load failed, shown in the channel until a load succeeds. */
  error: string | null;
  /** The running load is fetching older messages, so the list shows a hint. Catch-ups do not set it. */
  loadingOlder: boolean;
}

interface ChatState {
  channels: Record<string, ChannelChat>;
  /** messageId -> decrypted body. null = key not available yet; absent = not attempted. */
  payloads: Record<string, MessagePayload | null>;
  /** channelId -> userId -> last typing frame time (ms) */
  typing: Record<string, Record<string, number>>;
  /** channelId -> unsent composer text, kept across channel switches */
  drafts: Record<string, string>;
  setDraft: (channelId: string, text: string) => void;
}

const EMPTY: ChannelChat = { messages: [], loaded: false, hasMore: false, loading: false, error: null, loadingOlder: false };
const TYPING_SEND_MS = 3000;

export const useChat = create<ChatState>(() => ({
  channels: {},
  payloads: {},
  typing: {},
  drafts: {},
  setDraft: (channelId, text) => useChat.setState((s) => ({ drafts: { ...s.drafts, [channelId]: text } })),
}));

// On logout, drop the cache so the next person on this computer never sees the previous account's messages or drafts.
onBeforeSignOut(() => useChat.setState({ channels: {}, payloads: {}, typing: {}, drafts: {} }));

const channelOf = (id: string) => useChat.getState().channels[id] ?? EMPTY;

/**
 * Drops the cache of channels the account no longer has: removed, left, or deleted with their server. Their
 * messages, drafts and typing are cleared, and a load still running for them cannot put them back.
 */
export function forgetChatChannels(channelIds: string[]) {
  if (channelIds.length === 0) return;
  const gone = new Set(channelIds);
  useChat.setState((s) => {
    const channels = { ...s.channels };
    const payloads = { ...s.payloads };
    const typing = { ...s.typing };
    const drafts = { ...s.drafts };
    for (const id of gone) {
      for (const m of channels[id]?.messages ?? []) delete payloads[m.id];
      delete channels[id];
      delete typing[id];
      delete drafts[id];
      catchUpWanted.delete(id);
      olderWanted.delete(id);
    }
    return { channels, payloads, typing, drafts };
  });
}

function patchChannel(channelId: string, patch: Partial<ChannelChat>) {
  // A load that finishes after its channel was removed must not recreate the channel's cache.
  if (!isLiveChannel(channelId)) return;
  useChat.setState((s) => ({
    channels: { ...s.channels, [channelId]: { ...(s.channels[channelId] ?? EMPTY), ...patch } },
  }));
}

const byTime = (a: Message, b: Message) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/** Insert or replace by id, keeping chronological order. Dedupes the sender's own echo. */
function mergeMessages(channelId: string, incoming: Message[]) {
  if (!isLiveChannel(channelId)) return;
  useChat.setState((s) => {
    const cur = s.channels[channelId] ?? EMPTY;
    const byId = new Map(cur.messages.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    return { channels: { ...s.channels, [channelId]: { ...cur, messages: [...byId.values()].sort(byTime) } } };
  });
}

function removeMessages(channelId: string, messageIds: string[]) {
  if (messageIds.length === 0) return;
  const gone = new Set(messageIds);
  useChat.setState((s) => {
    const cur = s.channels[channelId];
    if (!cur) return {};
    return { channels: { ...s.channels, [channelId]: { ...cur, messages: cur.messages.filter((m) => !gone.has(m.id)) } } };
  });
}

const removeMessage = (channelId: string, messageId: string) => removeMessages(channelId, [messageId]);

/** Decrypt messages that are still in the cache. A result is dropped if the message changed meanwhile. */
async function decryptAll(channelId: string, msgs: Message[]) {
  const results = await Promise.all(
    msgs.map(async (m) => ({ m, payload: await decryptMessage(m).catch(() => null) })),
  );
  useChat.setState((s) => {
    const live = s.channels[channelId]?.messages ?? [];
    const payloads = { ...s.payloads };
    for (const { m, payload } of results) {
      if (live.some((x) => x.id === m.id && x.ciphertext === m.ciphertext)) payloads[m.id] = payload;
    }
    return { payloads };
  });
}

/** Called when new channel keys arrive: retry anything that could not be decrypted yet. */
function retryPending() {
  const { channels, payloads } = useChat.getState();
  for (const [channelId, c] of Object.entries(channels)) {
    const pending = c.messages.filter((m) => payloads[m.id] == null);
    if (pending.length) void decryptAll(channelId, pending);
  }
}

/** Channels whose catch-up was asked for while a page load or another catch-up was running. */
const catchUpWanted = new Set<string>();
/** Channels whose older page was asked for while another load was running. */
const olderWanted = new Set<string>();

/** Edits and deletes seen while a catch-up runs. Applied after its merge, since the page it fetched may predate them. */
interface Missed {
  deleted: Set<string>;
  edited: Map<string, Message>;
}
const missedDuringCatchUp = new Map<string, Missed>();

function noteMissed(channelId: string, change: (missed: Missed) => void) {
  const missed = missedDuringCatchUp.get(channelId);
  if (missed) change(missed);
}

function applyMissed(channelId: string, missed: Missed) {
  const held = new Set(channelOf(channelId).messages.map((m) => m.id));
  const edits = [...missed.edited.values()].filter((m) => held.has(m.id) && !missed.deleted.has(m.id));
  if (edits.length) {
    mergeMessages(channelId, edits);
    void decryptAll(channelId, edits);
  }
  removeMessages(channelId, [...missed.deleted]);
}

/** Ends a load and runs what was asked for meanwhile: a catch-up first, then an older page. */
function endLoad(channelId: string, patch: Partial<ChannelChat> = {}) {
  patchChannel(channelId, { loading: false, loadingOlder: false, ...patch });
  // A catch-up's own end runs the older page that was waiting behind it.
  if (catchUpWanted.delete(channelId)) {
    void catchUp(channelId).catch(() => {});
  } else if (olderWanted.delete(channelId)) {
    void loadHistory(channelId, 'older').catch(() => {});
  }
}

export async function loadHistory(channelId: string, mode: 'initial' | 'older' = 'initial') {
  const cur = channelOf(channelId);
  if (mode === 'initial' && cur.loaded) return;
  if (mode === 'older' && (!cur.hasMore || cur.messages.length === 0)) return;
  if (cur.loading) {
    // A scroll-up during a catch-up or reconnect must not be lost, so ask again once the running load ends.
    if (mode === 'older') olderWanted.add(channelId);
    return;
  }

  patchChannel(channelId, { loading: true, loadingOlder: mode === 'older', error: null });
  try {
    const before = mode === 'older' ? `&before=${cur.messages[0].id}` : '';
    const { messages } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}${before}`,
    );
    mergeMessages(channelId, messages);
    endLoad(channelId, { loaded: true, hasMore: messages.length >= LIMITS.HISTORY_PAGE });
    void decryptAll(channelId, messages);
  } catch (e) {
    const fallback = mode === 'older' ? 'Could not load older messages' : 'Could not load messages';
    endLoad(channelId, { error: e instanceof Error ? e.message : fallback });
    throw e;
  }
}

/**
 * After a reconnect, frames may have been missed. Fetch only what is newer than the newest message we hold, one
 * page at a time, so a gap of any length is filled. Then read the latest page once more and merge it, so edits
 * made while we were away are applied. Held messages inside that page's range which it no longer returns were
 * deleted while we were away, so they are dropped. Held messages older than that page are not re-checked; a
 * fresh load of the channel picks those up.
 */
export async function catchUp(channelId: string) {
  const cur = channelOf(channelId);
  if (!cur.loaded) return;
  if (cur.loading) {
    // A load is in flight, so the frames we missed may predate its snapshot. Run again once it ends.
    catchUpWanted.add(channelId);
    return;
  }

  patchChannel(channelId, { loading: true });
  const missed: Missed = { deleted: new Set(), edited: new Map() };
  missedDuringCatchUp.set(channelId, missed);
  try {
    // Snapshot first: messages that arrive over the socket during the catch-up are new, not deleted.
    const held = cur.messages.map((m) => m.id);
    let cursor = held[held.length - 1];
    for (;;) {
      const after = cursor ? `&after=${cursor}` : '';
      const { messages } = await api.get<{ messages: Message[] }>(
        `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}${after}`,
      );
      mergeMessages(channelId, messages);
      void decryptAll(channelId, messages);
      if (messages.length < LIMITS.HISTORY_PAGE) break;
      cursor = messages[messages.length - 1].id;
    }

    const { messages: latest } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}`,
    );
    // Merge before the deletion check so edits to held messages land too; the check only removes held ids.
    mergeMessages(channelId, latest);
    void decryptAll(channelId, latest);
    // A short page means it holds the whole channel, so every held message is in its range.
    const floor = latest.length < LIMITS.HISTORY_PAGE ? '' : latest.reduce((min, m) => (m.id < min ? m.id : min), latest[0].id);
    const present = new Set(latest.map((m) => m.id));
    removeMessages(channelId, held.filter((id) => id >= floor && !present.has(id)));
    // The catch-up reached the newest page, so an older-page error from before is no longer true.
    patchChannel(channelId, { error: null });
  } finally {
    // Stop recording first: a queued catch-up started by endLoad records its own changes.
    missedDuringCatchUp.delete(channelId);
    applyMissed(channelId, missed);
    endLoad(channelId);
  }
}

function requireMe(): string {
  const me = useSession.getState().user;
  if (!me) throw new Error('Not signed in');
  return me.id;
}

async function buildPayload(text: string, attachments?: Attachment[], gif?: Gif): Promise<MessagePayload> {
  const urls = extractUrls(text);
  const linkPreviews = urls.length ? await buildLinkPreviews(urls) : [];
  return {
    text,
    ...(attachments?.length ? { attachments } : {}),
    ...(gif ? { gif } : {}),
    ...(linkPreviews.length ? { linkPreviews } : {}),
  };
}

export async function sendMessage(channelId: string, input: { text: string; files: File[]; gif?: Gif }) {
  const me = requireMe();
  const attachments = input.files.length ? await Promise.all(input.files.map((f) => uploadAttachment(f))) : undefined;
  const built = await buildPayload(input.text, attachments, input.gif);
  const { payload, ciphertext, keyVersion } = await encryptWithinLimit(channelId, me, built);
  const attachmentIds = attachments?.map((a) => a.uploadId) ?? [];
  // One id for every try of this send, so the server returns the first copy instead of storing a second.
  const body = { ciphertext, keyVersion, attachmentIds, clientId: crypto.randomUUID() };
  const path = `/api/channels/${channelId}/messages`;
  let message: Message;
  try {
    ({ message } = await api.post<{ message: Message }>(path, body));
  } catch (e) {
    // A server error is final. Anything else (a timeout, a dropped connection) may still have stored the message.
    if (e instanceof ApiError) throw e;
    // Pull in what the server has first, so the channel shows the message if it went through, then send again.
    await catchUp(channelId).catch(() => {});
    try {
      ({ message } = await api.post<{ message: Message }>(path, body));
    } catch (again) {
      if (again instanceof ApiError) throw again;
      throw new Error('Not sure it sent. Check the channel before sending again.');
    }
  }
  mergeMessages(channelId, [message]);
  useChat.setState((s) => ({ payloads: { ...s.payloads, [message.id]: payload } }));
}

export async function editMessage(m: Message, text: string) {
  const old = useChat.getState().payloads[m.id];
  const built = await buildPayload(text, old?.attachments, old?.gif);
  const { payload, ciphertext, keyVersion } = await encryptWithinLimit(m.channelId, m.authorId, built);
  const { message } = await api.patch<{ message: Message }>(`/api/messages/${m.id}`, { ciphertext, keyVersion });
  mergeMessages(m.channelId, [message]);
  useChat.setState((s) => ({ payloads: { ...s.payloads, [m.id]: payload } }));
}

/** Link-preview images can push a message past the server's ciphertext cap; fitPayload trims them first. */
function encryptWithinLimit(channelId: string, authorId: string, payload: MessagePayload) {
  return fitPayload(payload, (candidate) => encryptPayload(channelId, authorId, candidate), shrinkPreviewImage);
}

export async function deleteMessage(m: Message) {
  await api.del(`/api/messages/${m.id}`);
  removeMessage(m.channelId, m.id);
}

let lastTypingSent = 0;
/** Tell the channel we are typing; throttled so a keystroke burst sends one frame. */
export function sendTyping(channelId: string) {
  const now = Date.now();
  if (now - lastTypingSent < TYPING_SEND_MS) return;
  lastTypingSent = now;
  sendFrame({ t: 'typing', channelId });
}

function noteTyping(channelId: string, userId: string) {
  if (userId === useSession.getState().user?.id) return;
  useChat.setState((s) => ({
    typing: { ...s.typing, [channelId]: { ...s.typing[channelId], [userId]: Date.now() } },
  }));
}

function onIncoming(m: Message) {
  if (channelOf(m.channelId).loaded) {
    mergeMessages(m.channelId, [m]);
    void decryptAll(m.channelId, [m]);
  }
  if (m.authorId === useSession.getState().user?.id) return;
  const session = useSession.getState();
  // The open text channel and the chat under a theater-mode share are both on screen.
  const onScreen = session.activeChannelId === m.channelId || session.theaterChatId === m.channelId;
  const visible = onScreen && !document.hidden;
  if (visible) session.clearUnread(m.channelId);
  else session.bumpUnread(m.channelId);
}

// Module-level subscriptions: the chat cache stays current even for channels that are not on screen.
onFrame((f) => {
  switch (f.t) {
    case 'message.new':
      onIncoming(f.message);
      return;
    case 'message.edit': {
      noteMissed(f.message.channelId, (missed) => missed.edited.set(f.message.id, f.message));
      // Only edits to messages we already hold. An edit to an unloaded message must not be merged in,
      // or it would become the oldest message in the cache and hide the gap from paging and catch-up.
      const held = useChat.getState().channels[f.message.channelId]?.messages.some((m) => m.id === f.message.id);
      if (!held) return;
      mergeMessages(f.message.channelId, [f.message]);
      void decryptAll(f.message.channelId, [f.message]);
      return;
    }
    case 'message.delete':
      noteMissed(f.channelId, (missed) => {
        missed.edited.delete(f.messageId);
        missed.deleted.add(f.messageId);
      });
      removeMessage(f.channelId, f.messageId);
      return;
    case 'typing':
      noteTyping(f.channelId, f.userId);
      return;
    case 'ready':
      // After a (re)connect, frames may have been missed: catch up every channel we already hold. A channel whose
      // first load failed (or never finished) is loaded again, and one still loading is caught up when it ends.
      // A channel the account no longer has is skipped, so its cache does not keep asking the server for it.
      for (const [id, c] of Object.entries(useChat.getState().channels)) {
        if (!isLiveChannel(id)) continue;
        if (c.loaded) {
          void catchUp(id).catch(() => {});
          // An older page that failed has a Retry in the channel, and a reconnect is a good time to try it again.
          if (c.error) void loadHistory(id, 'older').catch(() => {});
        } else if (c.loading) catchUpWanted.add(id);
        else void loadHistory(id).catch(() => {});
      }
      void refreshUnread().catch(() => {});
      return;
  }
});

onKeysChanged(retryPending);
