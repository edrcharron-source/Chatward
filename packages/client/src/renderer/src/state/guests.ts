// The demo's chatter bots on a real server. The server only names a guest and a line or clip number; the profiles,
// text and recordings are the demo's own, bundled in the app. Guest messages are kept in memory and never sent anywhere.
import { useMemo } from 'react';
import { create } from 'zustand';
import {
  CHATTER_LINES,
  CHATTER_REPLIES,
  type GuestState,
  type Member,
  type Message,
  type MessagePayload,
  type ServerFrame,
  type User,
} from '@chatward/shared';
import { api } from '../api/http';
import { onFrame } from '../api/ws';
import { isDemo } from '../demo';
import { BOT_SEEDS } from '../demo/backend/world';
import { loadClips } from '../demo/voice';
import { useChat } from './chat';
import { onBeforeSignOut, useSession } from './session';
import { useVoice } from './voice';
import { attachRemote, detachRemote } from './voiceAudio';

export interface GuestMessage { message: Message; payload: MessagePayload }

interface GuestsStore {
  /** serverId -> who is here */
  rooms: Record<string, GuestState>;
  /** channelId -> oldest first */
  messages: Record<string, GuestMessage[]>;
  /** guest user ids playing a clip in our call */
  speaking: string[];
}

const KEPT_PER_CHANNEL = 200;
const KEY_GAP_MS = 1500;
const JOINED = Date.UTC(2025, 2, 14);

export const GUEST_USERS: User[] = BOT_SEEDS.map((b) => ({
  id: `guest-${b.name.toLowerCase()}`, username: b.name.toLowerCase(), displayName: b.name, avatarUrl: null,
  profile: { ...b.profile, bannerUrl: null, createdAt: JOINED },
}));
const GUEST_MEMBERS: Member[] = GUEST_USERS.map((user) => ({ user, role: 'member', devices: [] }));
const NONE: Member[] = [];

export const useGuests = create<GuestsStore>(() => ({ rooms: {}, messages: {}, speaking: [] }));

export const isGuest = (userId: string) => GUEST_USERS.some((u) => u.id === userId);
/** A guest's member entry, also after they left, so their lines keep a name. */
export const guestMember = (userId: string) => GUEST_MEMBERS.find((m) => m.user.id === userId);

/** The server's guests as members, for display only. */
export function useGuestMembers(serverId: string | undefined): Member[] {
  const room = useGuests((s) => (serverId ? s.rooms[serverId] : undefined));
  return useMemo(() => room?.guests.flatMap((g) => GUEST_MEMBERS[g] ?? []) ?? NONE, [room]);
}

/** Guest user ids in a voice channel. */
export function useGuestsInVoice(channelId: string | undefined): string[] {
  const rooms = useGuests((s) => s.rooms);
  return useMemo(() => {
    const room = Object.values(rooms).find((r) => r.voiceChannelId === channelId);
    return room?.inVoice.flatMap((g) => GUEST_USERS[g]?.id ?? []) ?? [];
  }, [rooms, channelId]);
}

function setRoom(state: GuestState) {
  useGuests.setState((s) => ({ rooms: { ...s.rooms, [state.serverId]: state } }));
  // a guest who left the call stops talking
  for (const [userId, stop] of playing) {
    const n = GUEST_USERS.findIndex((u) => u.id === userId);
    if (!state.inVoice.includes(n)) stop();
  }
}

async function refresh() {
  for (const b of useSession.getState().servers) {
    try {
      setRoom(await api.get<GuestState>(`/api/servers/${b.server.id}/guests`));
    } catch { /* a server without guests support */ }
  }
}

function addMessage(f: Extract<ServerFrame, { t: 'guests.say' }>) {
  const text = (f.reply ? CHATTER_REPLIES : CHATTER_LINES)[f.line];
  const author = GUEST_USERS[f.guest];
  if (text === undefined || !author) return;
  const message: Message = { id: f.id, channelId: f.channelId, authorId: author.id, createdAt: f.createdAt, editedAt: null, keyVersion: 0, ciphertext: '' };
  useGuests.setState((s) => ({
    messages: { ...s.messages, [f.channelId]: [...(s.messages[f.channelId] ?? []), { message, payload: { text } }].slice(-KEPT_PER_CHANNEL) },
  }));
  useChat.setState((s) => {
    const typing = { ...s.typing[f.channelId] };
    delete typing[author.id];
    return { typing: { ...s.typing, [f.channelId]: typing } };
  });
  const session = useSession.getState();
  const onScreen = session.activeChannelId === f.channelId || session.theaterChatId === f.channelId;
  if (onScreen && !document.hidden) session.clearUnread(f.channelId);
  else session.bumpUnread(f.channelId);
}

// ---------- voice ----------

let audio: { ctx: AudioContext; clips: Promise<AudioBuffer[]> } | null = null;
const playing = new Map<string, () => void>();

function setSpeaking(userId: string, on: boolean) {
  useGuests.setState((s) => ({ speaking: on ? [...s.speaking.filter((id) => id !== userId), userId] : s.speaking.filter((id) => id !== userId) }));
}

/** Plays a recording as the guest's voice, through the call's own output so volume, mute and deafen apply. */
async function speak(guest: number, clipNumber: number) {
  const user = GUEST_USERS[guest];
  if (!user) return;
  if (!audio) {
    const ctx = new AudioContext();
    audio = { ctx, clips: loadClips(ctx) };
  }
  const { ctx } = audio;
  const clip = (await audio.clips)[clipNumber];
  if (!clip || audio?.ctx !== ctx) return;
  void ctx.resume();
  playing.get(user.id)?.();
  const dest = ctx.createMediaStreamDestination();
  const level = ctx.createGain();
  level.gain.value = 0.9;
  level.connect(dest);
  const src = ctx.createBufferSource();
  src.buffer = clip;
  src.connect(level);
  const key = `guest:${user.id}`;
  attachRemote(key, user.id, dest.stream.getAudioTracks()[0]);
  const stop = () => {
    src.onended = null;
    try { src.stop(); } catch { /* already ended */ }
    detachRemote(key);
    playing.delete(user.id);
    setSpeaking(user.id, false);
  };
  src.onended = stop;
  playing.set(user.id, stop);
  setSpeaking(user.id, true);
  src.start();
}

function stopVoice() {
  for (const stop of [...playing.values()]) stop();
  void audio?.ctx.close();
  audio = null;
}

useVoice.subscribe((s, prev) => {
  if (prev.channelId && s.channelId !== prev.channelId) stopVoice();
});

// ---------- frames ----------

onFrame((f) => {
  switch (f.t) {
    case 'ready':
      void refresh();
      return;
    case 'guests.state':
      setRoom(f.state);
      return;
    case 'guests.typing': {
      const user = GUEST_USERS[f.guest];
      if (!user) return;
      useChat.setState((s) => ({ typing: { ...s.typing, [f.channelId]: { ...s.typing[f.channelId], [user.id]: Date.now() } } }));
      return;
    }
    case 'guests.say':
      addMessage(f);
      return;
    case 'guests.speak': {
      const v = useVoice.getState();
      if (v.channelId === f.channelId && v.status === 'connected') void speak(f.guest, f.clip);
      return;
    }
  }
});

function clear() {
  stopVoice();
  useGuests.setState({ rooms: {}, messages: {}, speaking: [] });
}
onBeforeSignOut(clear);
useSession.subscribe((s, prev) => {
  if (prev.token && !s.token) clear();
});

// ---------- keys ----------

let typed = '';
let lastKey = 0;

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

async function change(method: 'post' | 'del') {
  const { token, activeServerId, servers } = useSession.getState();
  const serverId = activeServerId ?? servers[0]?.server.id;
  if (!token || !serverId || isDemo()) return;
  try {
    setRoom(await api[method]<GuestState>(`/api/servers/${serverId}/guests`));
  } catch { /* a server without guests support */ }
}

/** Typed in the main window, outside any text box: - - - + and + + + -. */
export function installGuestKeys(win: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || isTextField(e.target) || (e.key !== '-' && e.key !== '+')) {
      typed = '';
      return;
    }
    const now = Date.now();
    if (now - lastKey > KEY_GAP_MS) typed = '';
    lastKey = now;
    typed = (typed + e.key).slice(-4);
    if (typed === '---+') {
      typed = '';
      void change('post');
    } else if (typed === '+++-') {
      typed = '';
      void change('del');
    }
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}
