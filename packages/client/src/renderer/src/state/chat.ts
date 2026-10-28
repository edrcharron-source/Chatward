import { create } from 'zustand';
import { LIMITS, type Attachment, type Message, type MessagePayload } from '@chatward/shared';
import { api } from '../api/http';
import { onFrame, sendFrame } from '../api/ws';
import { buildLinkPreviews, extractUrls, uploadAttachment } from '../components/media';
import { decryptMessage, encryptPayload, onKeysChanged } from '../crypto';
import { useSession } from './session';

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

function removeMessage(channelId: string, messageId: string) {
  useChat.setState((s) => {
    const cur = s.channels[channelId];
    if (!cur) return {};
    return { channels: { ...s.channels, [channelId]: { ...cur, messages: cur.messages.filter((m) => m.id !== messageId) } } };
  });
}

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

export async function loadHistory(channelId: string, mode: 'initial' | 'older' | 'refresh' = 'initial') {
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
      hasMore: mode === 'refresh' ? cur.hasMore : messages.length >= LIMITS.HISTORY_PAGE,
    });
    void decryptAll(channelId, messages);
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
  const payload = await buildPayload(input.text, attachments, input.gif);
  const { ciphertext, keyVersion } = await encryptPayload(channelId, me, payload);
  const attachmentIds = attachments?.map((a) => a.uploadId) ?? [];
  const { message } = await api.post<{ message: Message }>(`/api/channels/${channelId}/messages`, { ciphertext, keyVersion, attachmentIds });
  mergeMessages(channelId, [message]);
  useChat.setState((s) => ({ payloads: { ...s.payloads, [message.id]: payload } }));
}

export async function editMessage(m: Message, text: string) {
  const old = useChat.getState().payloads[m.id];
  const payload = await buildPayload(text, old?.attachments, old?.gif);
  const { ciphertext, keyVersion } = await encryptPayload(m.channelId, m.authorId, payload);
  const { message } = await api.patch<{ message: Message }>(`/api/messages/${m.id}`, { ciphertext, keyVersion });
  mergeMessages(m.channelId, [message]);
  useChat.setState((s) => ({ payloads: { ...s.payloads, [m.id]: payload } }));
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
  const visible = session.activeChannelId === m.channelId && !document.hidden;
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
      // After a (re)connect, frames may have been missed: refresh every channel we already hold.
      for (const [id, c] of Object.entries(useChat.getState().channels)) {
        if (c.loaded) void loadHistory(id, 'refresh').catch(() => {});
      }
      return;
  }
});

onKeysChanged(retryPending);
