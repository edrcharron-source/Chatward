import { create } from 'zustand';
import { LIMITS, type Attachment, type Message, type MessagePayload } from '@chatward/shared';
import { api } from '../api/http';
import { onFrame, sendFrame } from '../api/ws';
import { buildLinkPreviews, extractUrls, shrinkPreviewImage, uploadAttachment } from '../components/media';
import { decryptMessage, encryptPayload, onKeysChanged } from '../crypto';
import { fitPayload } from './fitPayload';
import { onBeforeSignOut, refreshUnread, useSession } from './session';

export type Gif = NonNullable<MessagePayload['gif']>;

export interface ChannelChat {
  /** Oldest first. */
  messages: Message[];
  loaded: boolean;
  hasMore: boolean;
  loading: boolean;
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

const EMPTY: ChannelChat = { messages: [], loaded: false, hasMore: false, loading: false };
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

function patchChannel(channelId: string, patch: Partial<ChannelChat>) {
  useChat.setState((s) => ({
    channels: { ...s.channels, [channelId]: { ...(s.channels[channelId] ?? EMPTY), ...patch } },
  }));
}

const byTime = (a: Message, b: Message) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/** Insert or replace by id, keeping chronological order. Dedupes the sender's own echo. */
function mergeMessages(channelId: string, incoming: Message[]) {
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

export async function loadHistory(channelId: string, mode: 'initial' | 'older' = 'initial') {
  const cur = channelOf(channelId);
  if (cur.loading) return;
  if (mode === 'initial' && cur.loaded) return;
  if (mode === 'older' && (!cur.hasMore || cur.messages.length === 0)) return;

  patchChannel(channelId, { loading: true });
  try {
    const before = mode === 'older' ? `&before=${cur.messages[0].id}` : '';
    const { messages } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}${before}`,
    );
    mergeMessages(channelId, messages);
    patchChannel(channelId, {
      loaded: true,
      loading: false,
      hasMore: messages.length >= LIMITS.HISTORY_PAGE,
    });
    void decryptAll(channelId, messages);
  } catch (e) {
    patchChannel(channelId, { loading: false });
    throw e;
  }
}

/**
 * After a reconnect, frames may have been missed. Walk forward one page at a time from the oldest message we
 * hold until the server has nothing newer, so a gap of any length is filled. Messages we held inside that walk
 * which the server no longer returns were deleted while we were away, so they are dropped.
 */
export async function catchUp(channelId: string) {
  const cur = channelOf(channelId);
  if (cur.loading || !cur.loaded) return;

  patchChannel(channelId, { loading: true });
  try {
    const anchor = cur.messages[0]?.id;
    // Snapshot first: messages that arrive over the socket during the walk are new, not deleted.
    const held = cur.messages.map((m) => m.id);
    const seen = new Set<string>();
    let cursor = anchor;
    for (;;) {
      const after = cursor ? `&after=${cursor}` : '';
      const { messages } = await api.get<{ messages: Message[] }>(
        `/api/channels/${channelId}/messages?limit=${LIMITS.HISTORY_PAGE}${after}`,
      );
      for (const m of messages) seen.add(m.id);
      mergeMessages(channelId, messages);
      void decryptAll(channelId, messages);
      if (messages.length < LIMITS.HISTORY_PAGE) break;
      cursor = messages[messages.length - 1].id;
    }
    const gone = anchor ? held.filter((id) => id > anchor && !seen.has(id)) : [];
    removeMessages(channelId, gone);
    patchChannel(channelId, { loading: false });
  } catch (e) {
    patchChannel(channelId, { loading: false });
    throw e;
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
  const { message } = await api.post<{ message: Message }>(`/api/channels/${channelId}/messages`, { ciphertext, keyVersion, attachmentIds });
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
    case 'message.edit':
      mergeMessages(f.message.channelId, [f.message]);
      void decryptAll(f.message.channelId, [f.message]);
      return;
    case 'message.delete':
      removeMessage(f.channelId, f.messageId);
      return;
    case 'typing':
      noteTyping(f.channelId, f.userId);
      return;
    case 'ready':
      // After a (re)connect, frames may have been missed: catch up every channel we already hold.
      for (const [id, c] of Object.entries(useChat.getState().channels)) {
        if (c.loaded) void catchUp(id).catch(() => {});
      }
      void refreshUnread().catch(() => {});
      return;
  }
});

onKeysChanged(retryPending);
