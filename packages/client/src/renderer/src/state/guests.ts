// The demo's chatter bots ("guests") on a real server, run by the app that added them. Nothing on the server
// changes: a guest's line, its host's roster and a request to send a guest away are ordinary end-to-end encrypted
// messages with a `chatter` tag. The app that added a guest is its host and does all its talking; everyone else's
// app only shows it, and drops it once the host goes offline. Line text always comes from the app's own lists.
import { useMemo } from 'react';
import { create } from 'zustand';
import { RoomEvent, type RemoteParticipant, type Room } from 'livekit-client';
import {
  CHATTER_LINES,
  CHATTER_REPLIES,
  CHATTER_TIMING,
  chatterClip,
  chatterWait,
  GUESTS_MAX,
  type ChatterTag,
  type Member,
  type Message,
  type MessagePayload,
  type User,
} from '@chatward/shared';
import { api } from '../api/http';
import { onFrame } from '../api/ws';
import { decryptMessage, encryptPayload } from '../crypto';
import { isDemo } from '../demo';
import { BOT_SEEDS } from '../demo/backend/world';
import { loadClips } from '../demo/voice';
import { loadHistory, useChat } from './chat';
import { onBeforeSignOut, useSession } from './session';
import { useVoice } from './voice';
import { attachRemote, detachRemote, voiceAudio } from './voiceAudio';

interface Roster { session: string; guests: number[]; at: number }

interface GuestsStore {
  /** serverId -> host userId -> that host's latest roster */
  hosts: Record<string, Record<string, Roster>>;
  /** serverId -> the guests this app hosts, oldest first */
  mine: Record<string, number[]>;
  /** guest user ids playing a clip in our call (this app's guests only) */
  speaking: string[];
}

/** One run of this app. A restarted app is a new session, so its earlier guests are gone. */
const SESSION = crypto.randomUUID();
const KEY_GAP_MS = 1500;
const JOINED = Date.UTC(2025, 2, 14);

export const GUEST_USERS: User[] = BOT_SEEDS.slice(0, GUESTS_MAX).map((b) => ({
  id: `guest-${b.name.toLowerCase()}`, username: b.name.toLowerCase(), displayName: b.name, avatarUrl: null,
  profile: { ...b.profile, bannerUrl: null, createdAt: JOINED },
}));
const GUEST_MEMBERS: Member[] = GUEST_USERS.map((user) => ({ user, role: 'member', devices: [] }));
const NONE: Member[] = [];

export const useGuests = create<GuestsStore>(() => ({ hosts: {}, mine: {}, speaking: [] }));

export const isGuest = (userId: string) => GUEST_USERS.some((u) => u.id === userId);
/** A guest's member entry, also after they left, so their lines keep a name. */
export const guestMember = (userId: string) => GUEST_MEMBERS.find((m) => m.user.id === userId);

// ---------- who is here ----------

interface Seat { guest: number; host: string; at: number }

/** Guests on a server: this app's own, plus those of other hosts who are still online. */
function seatsOf(serverId: string, g: GuestsStore, meId: string | undefined, presence: Record<string, string>): Seat[] {
  const seats: Seat[] = (g.mine[serverId] ?? []).map((guest, i) => ({ guest, host: meId ?? '', at: i }));
  for (const [host, r] of Object.entries(g.hosts[serverId] ?? {})) {
    if (host === meId || (presence[host] ?? 'offline') === 'offline') continue;
    for (const guest of r.guests) if (!seats.some((s) => s.guest === guest)) seats.push({ guest, host, at: r.at });
  }
  return seats;
}

function currentSeats(serverId: string): Seat[] {
  const { user, presence } = useSession.getState();
  return seatsOf(serverId, useGuests.getState(), user?.id, presence);
}

function useSeats(serverId: string | undefined): Seat[] {
  const g = useGuests();
  const meId = useSession((s) => s.user?.id);
  const presence = useSession((s) => s.presence);
  return useMemo(() => (serverId ? seatsOf(serverId, g, meId, presence) : []), [serverId, g, meId, presence]);
}

/** The server's guests as members, for display only. */
export function useGuestMembers(serverId: string | undefined): Member[] {
  const seats = useSeats(serverId);
  return useMemo(() => (seats.length ? seats.flatMap((s) => GUEST_MEMBERS[s.guest] ?? []) : NONE), [seats]);
}

/** Guest user id -> the voice channel they sit in: the one their host is in. */
export function useGuestVoice(serverId: string | undefined): Map<string, string> {
  const seats = useSeats(serverId);
  const occupants = useSession((s) => s.voiceOccupants);
  const meId = useSession((s) => s.user?.id);
  const myCall = useVoice((s) => s.channelId);
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const s of seats) {
      const call = s.host === meId ? myCall : Object.keys(occupants).find((ch) => occupants[ch]?.includes(s.host));
      if (call && GUEST_USERS[s.guest]) out.set(GUEST_USERS[s.guest].id, call);
    }
    return out;
  }, [seats, occupants, meId, myCall]);
}

/** Guest user ids in a voice channel. */
export function useGuestsInVoice(serverId: string | undefined, channelId: string): string[] {
  const voice = useGuestVoice(serverId);
  return useMemo(() => [...voice].filter(([, ch]) => ch === channelId).map(([id]) => id), [voice, channelId]);
}

/** What a chatter message shows: the guest as its author and the line from the app's own list. */
export function chatterView(payload: MessagePayload | null | undefined): { hidden: boolean; author?: User; payload?: MessagePayload } {
  const tag = payload?.chatter;
  if (!tag) return { hidden: false };
  if (tag.kind !== 'line' || !validGuest(tag.guest)) return { hidden: true };
  const text = (tag.reply ? CHATTER_REPLIES : CHATTER_LINES)[tag.line];
  return text === undefined ? { hidden: true } : { hidden: false, author: GUEST_USERS[tag.guest], payload: { text } };
}

// ---------- reading tags ----------

const validGuest = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < GUESTS_MAX;
const validRoster = (r: unknown): r is number[] => Array.isArray(r) && r.length <= GUESTS_MAX && r.every(validGuest);

function serverOfChannel(channelId: string): string | undefined {
  return useSession.getState().servers.find((b) => b.channels.some((c) => c.id === channelId))?.server.id;
}

function textChannels(serverId: string): string[] {
  return useSession.getState().servers.find((b) => b.server.id === serverId)?.channels.filter((c) => c.kind === 'text').map((c) => c.id) ?? [];
}

const seen = new Set<string>();
/** serverId -> the newest roster this account sent from an earlier run, found in history */
const leftovers = new Map<string, Roster>();

/** Applies one decrypted message. `live` is true for a message that just arrived rather than one read from history. */
function readTag(m: Message, payload: MessagePayload | null, live: boolean) {
  const tag = payload?.chatter;
  if (seen.has(m.id)) return;
  seen.add(m.id);
  const serverId = serverOfChannel(m.channelId);
  const meId = useSession.getState().user?.id;
  if (!serverId || !meId) return;
  if (!tag) {
    if (live) answer(serverId, m.channelId);
    return;
  }
  if (live && tag.kind !== 'line' && m.authorId !== meId) unbump(m.channelId);
  if (tag.kind === 'remove') {
    if (live && tag.host === meId && validGuest(tag.guest)) dismiss(serverId, tag.guest);
    return;
  }
  if (typeof tag.session !== 'string' || !validRoster(tag.roster)) return;
  const roster: Roster = { session: tag.session, guests: [...new Set(tag.roster)], at: m.createdAt };
  if (m.authorId === meId) {
    if (tag.session !== SESSION && (leftovers.get(serverId)?.at ?? -1) < roster.at) leftovers.set(serverId, roster);
    return;
  }
  useGuests.setState((s) => {
    const prev = s.hosts[serverId]?.[m.authorId];
    if (prev && prev.at > roster.at) return {};
    return { hosts: { ...s.hosts, [serverId]: { ...s.hosts[serverId], [m.authorId]: roster } } };
  });
}

/** Roster and remove messages are hidden, so they should not leave an unread count behind. */
function unbump(channelId: string) {
  window.setTimeout(() => {
    const { unread } = useSession.getState();
    if (unread[channelId]) useSession.setState({ unread: { ...unread, [channelId]: unread[channelId] - 1 } });
  }, 0);
}

/** Reads the newest page of each server's first text channel, where rosters are sent, and tidies up after an earlier run. */
async function catchUpRosters() {
  for (const b of useSession.getState().servers) {
    const channelId = textChannels(b.server.id)[0];
    if (!channelId) continue;
    await loadHistory(channelId).catch(() => {});
    const messages = useChat.getState().channels[channelId]?.messages ?? [];
    await Promise.all(messages.map(async (m) => readTag(m, await decryptMessage(m).catch(() => null), false)));
    // Our previous run may have quit with guests still listed. If so, say they are gone.
    const old = leftovers.get(b.server.id);
    if (old?.guests.length && !(useGuests.getState().mine[b.server.id] ?? []).length) {
      leftovers.delete(b.server.id);
      void sendTag(channelId, { kind: 'roster', session: SESSION, roster: [] });
    }
  }
}

// ---------- sending ----------

async function sendTag(channelId: string, tag: ChatterTag) {
  const meId = useSession.getState().user?.id;
  if (!meId) return;
  // The text is for apps from before guests existed; current apps show the line from their own list.
  const text = tag.kind === 'line' ? (tag.reply ? CHATTER_REPLIES : CHATTER_LINES)[tag.line] : '';
  try {
    const { ciphertext, keyVersion } = await encryptPayload(channelId, meId, { text, chatter: tag });
    await api.post(`/api/channels/${channelId}/messages`, { ciphertext, keyVersion, attachmentIds: [], clientId: crypto.randomUUID() });
  } catch { /* no channel key yet, or offline: guests are best effort */ }
}

function sendRoster(serverId: string) {
  const channelId = textChannels(serverId)[0];
  if (channelId) void sendTag(channelId, { kind: 'roster', session: SESSION, roster: useGuests.getState().mine[serverId] ?? [] });
}

function say(serverId: string, channelId: string, reply: boolean) {
  const mine = useGuests.getState().mine[serverId] ?? [];
  if (!mine.length) return;
  const guest = mine[Math.floor(Math.random() * mine.length)];
  const line = Math.floor(Math.random() * (reply ? CHATTER_REPLIES.length : CHATTER_LINES.length));
  void sendTag(channelId, { kind: 'line', session: SESSION, roster: mine, guest, line, reply });
}

// ---------- hosting ----------

const timers = new Map<string, number[]>();

function later(serverId: string, ms: number, fn: () => void) {
  const list = timers.get(serverId) ?? [];
  const t = window.setTimeout(() => {
    timers.set(serverId, (timers.get(serverId) ?? []).filter((x) => x !== t));
    if ((useGuests.getState().mine[serverId] ?? []).length) fn();
  }, ms);
  timers.set(serverId, [...list, t]);
}

function stopHosting(serverId: string) {
  for (const t of timers.get(serverId) ?? []) window.clearTimeout(t);
  timers.delete(serverId);
}

/** Same timing as the demo: a line in a random text channel now and then, and clips in our call. */
function startHosting(serverId: string) {
  const textLoop = () => {
    const channels = textChannels(serverId);
    if (channels.length) say(serverId, channels[Math.floor(Math.random() * channels.length)], false);
    later(serverId, chatterWait(CHATTER_TIMING.nextLine), textLoop);
  };
  later(serverId, chatterWait(CHATTER_TIMING.firstLine), textLoop);
  const voiceLoop = () => {
    void speak(serverId).then((ms) => later(serverId, ms + chatterWait(CHATTER_TIMING.nextClip), voiceLoop));
  };
  later(serverId, chatterWait(CHATTER_TIMING.firstClip), voiceLoop);
}

/** Someone wrote in a text channel: like the demo, one guest answers. Only one host answers, so it is one reply. */
function answer(serverId: string, channelId: string) {
  const mine = useGuests.getState().mine[serverId] ?? [];
  const meId = useSession.getState().user?.id;
  if (!mine.length || !meId) return;
  const lead = [...new Set(currentSeats(serverId).map((s) => s.host))].sort()[0];
  if (lead !== meId) return;
  later(serverId, chatterWait(CHATTER_TIMING.replyPause) + chatterWait(CHATTER_TIMING.replyTyping), () => say(serverId, channelId, true));
}

function setMine(serverId: string, guests: number[]) {
  const before = useGuests.getState().mine[serverId] ?? [];
  useGuests.setState((s) => ({ mine: { ...s.mine, [serverId]: guests } }));
  if (!before.length && guests.length) startHosting(serverId);
  if (before.length && !guests.length) {
    stopHosting(serverId);
    stopVoice();
  }
  sendRoster(serverId);
}

function dismiss(serverId: string, guest: number) {
  const mine = useGuests.getState().mine[serverId] ?? [];
  if (mine.includes(guest)) setMine(serverId, mine.filter((g) => g !== guest));
}

function addGuest(serverId: string) {
  const taken = currentSeats(serverId).map((s) => s.guest);
  if (taken.length >= GUESTS_MAX) return;
  const guest = [...Array(GUESTS_MAX).keys()].find((g) => !taken.includes(g));
  if (guest === undefined) return;
  setMine(serverId, [...(useGuests.getState().mine[serverId] ?? []), guest]);
}

/** Sends the newest guest away: our own if we host any, otherwise asks the host whose guest arrived last. */
function removeGuest(serverId: string) {
  const mine = useGuests.getState().mine[serverId] ?? [];
  if (mine.length) {
    setMine(serverId, mine.slice(0, -1));
    return;
  }
  const newest = currentSeats(serverId).sort((a, b) => a.at - b.at).at(-1);
  const channelId = textChannels(serverId)[0];
  if (newest && channelId) void sendTag(channelId, { kind: 'remove', host: newest.host, guest: newest.guest });
}

// ---------- voice ----------

let clips: { ctx: AudioContext; list: Promise<AudioBuffer[]> } | null = null;
const playing = new Map<string, () => void>();
let lastClip = -1;
const CLIP_TOPIC = 'chatter-clip';

function setSpeaking(userId: string, on: boolean) {
  useGuests.setState((s) => ({ speaking: on ? [...s.speaking.filter((id) => id !== userId), userId] : s.speaking.filter((id) => id !== userId) }));
}

/** Decoded recordings for the call's audio context, in the demo's order. */
async function clipList(): Promise<{ ctx: AudioContext; list: AudioBuffer[] } | null> {
  const ctx = voiceAudio.ctx;
  if (!ctx) return null;
  if (clips?.ctx !== ctx) clips = { ctx, list: loadClips(ctx) };
  const list = await clips.list;
  return voiceAudio.ctx === ctx && list.length ? { ctx, list } : null;
}

/** Plays a recording here as the guest's own voice: their tile lights up, and their volume and mute apply. */
async function play(guest: number, clip: number) {
  const user = GUEST_USERS[guest];
  const audio = await clipList();
  const buffer = audio?.list[clip];
  if (!user || !audio || !buffer) return;
  const { ctx } = audio;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const level = ctx.createGain();
  level.gain.value = 0.9;
  src.connect(level);
  const out = ctx.createMediaStreamDestination();
  level.connect(out);
  const key = `guest:${user.id}`;
  playing.get(user.id)?.();
  attachRemote(key, user.id, out.stream.getAudioTracks()[0]);
  const stop = () => {
    src.onended = null;
    try { src.stop(); } catch { /* already ended */ }
    level.disconnect();
    detachRemote(key);
    playing.delete(user.id);
    setSpeaking(user.id, false);
  };
  src.onended = stop;
  playing.set(user.id, stop);
  setSpeaking(user.id, true);
  src.start();
}

/**
 * While we are in a call, one of our guests plays a recording. The call's data channel tells everyone else in the
 * call which guest and which recording, and each app plays it as that guest. Returns how long it lasts, in ms.
 */
async function speak(serverId: string): Promise<number> {
  const mine = useGuests.getState().mine[serverId] ?? [];
  const { room, status } = useVoice.getState();
  if (!mine.length || useVoice.getState().serverId !== serverId || status !== 'connected' || !room) return 0;
  const audio = await clipList();
  if (!audio) return 0;
  const clip = chatterClip(audio.list.length, lastClip);
  lastClip = clip;
  const guest = mine[Math.floor(Math.random() * mine.length)];
  void room.localParticipant
    .publishData(new TextEncoder().encode(JSON.stringify({ guest, clip })), { reliable: true, topic: CLIP_TOPIC })
    .catch(() => undefined);
  void play(guest, clip);
  return audio.list[clip].duration * 1000;
}

/** Another host's guest speaks in our call. Only the guest's own host can make it speak. */
function onClipData(payload: Uint8Array, from?: RemoteParticipant, _kind?: unknown, topic?: string) {
  const { serverId } = useVoice.getState();
  if (topic !== CLIP_TOPIC || !from || !serverId) return;
  let msg: { guest?: unknown; clip?: unknown };
  try { msg = JSON.parse(new TextDecoder().decode(payload)) as typeof msg; } catch { return; }
  if (!validGuest(msg.guest) || !Number.isInteger(msg.clip)) return;
  const guest = msg.guest;
  if (!currentSeats(serverId).some((s) => s.guest === guest && s.host === from.identity)) return;
  void play(guest, msg.clip as number);
}

let listening: Room | null = null;
useVoice.subscribe((s) => {
  if (s.room === listening) return;
  listening?.off(RoomEvent.DataReceived, onClipData);
  listening = s.room;
  listening?.on(RoomEvent.DataReceived, onClipData);
});

function stopVoice() {
  for (const stop of [...playing.values()]) stop();
}

useVoice.subscribe((s, prev) => {
  if (prev.channelId && s.channelId !== prev.channelId) stopVoice();
});

// ---------- wiring ----------

onFrame((f) => {
  if (f.t === 'ready') void catchUpRosters();
  if (f.t !== 'message.new') return;
  const m = f.message;
  void decryptMessage(m).then((p) => readTag(m, p, true), () => undefined);
});

function clear() {
  for (const serverId of [...timers.keys()]) stopHosting(serverId);
  stopVoice();
  seen.clear();
  leftovers.clear();
  useGuests.setState({ hosts: {}, mine: {}, speaking: [] });
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

function activeServer(): string | undefined {
  const { token, activeServerId, servers } = useSession.getState();
  if (!token || isDemo()) return undefined;
  return activeServerId ?? servers[0]?.server.id;
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
    const serverId = activeServer();
    if (typed === '---+') {
      typed = '';
      if (serverId) addGuest(serverId);
    } else if (typed === '+++-') {
      typed = '';
      if (serverId) removeGuest(serverId);
    }
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}
