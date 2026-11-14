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
  chatterChat,
  CHATTER_CHATS,
  chatterClip,
  chatterNamed,
  chatterReply,
  chatterText,
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

interface Roster { session: string; guests: number[]; at: number; textOnly: boolean }

interface GuestsStore {
  /** serverId -> host userId -> that host's latest roster */
  hosts: Record<string, Record<string, Roster>>;
  /** serverId -> the guests this app hosts, oldest first */
  mine: Record<string, number[]>;
  /** guest user ids playing a clip in our call (this app's guests only) */
  speaking: string[];
  /** Our guests stay in text channels: they leave voice and play no clips. Remembered on this computer. */
  textOnly: boolean;
}

const TEXT_ONLY_KEY = 'chatward.guests.textOnly';
function savedTextOnly(): boolean {
  try { return localStorage.getItem(TEXT_ONLY_KEY) === '1'; } catch { return false; }
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

export const useGuests = create<GuestsStore>(() => ({ hosts: {}, mine: {}, speaking: [], textOnly: savedTextOnly() }));

export const isGuest = (userId: string) => GUEST_USERS.some((u) => u.id === userId);
/** A guest's member entry, also after they left, so their lines keep a name. */
export const guestMember = (userId: string) => GUEST_MEMBERS.find((m) => m.user.id === userId);

// ---------- who is here ----------

interface Seat { guest: number; host: string; at: number; textOnly: boolean }

/** Guests on a server: this app's own, plus those of other hosts who are still online. */
function seatsOf(serverId: string, g: GuestsStore, meId: string | undefined, presence: Record<string, string>): Seat[] {
  const seats: Seat[] = (g.mine[serverId] ?? []).map((guest, i) => ({ guest, host: meId ?? '', at: i, textOnly: g.textOnly }));
  for (const [host, r] of Object.entries(g.hosts[serverId] ?? {})) {
    if (host === meId || (presence[host] ?? 'offline') === 'offline') continue;
    for (const guest of r.guests) if (!seats.some((s) => s.guest === guest)) seats.push({ guest, host, at: r.at, textOnly: r.textOnly });
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
      if (s.textOnly) continue;
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
    if (live && payload) answer(serverId, m.channelId, payload);
    return;
  }
  if (live && tag.kind !== 'line' && m.authorId !== meId) unbump(m.channelId);
  if (tag.kind === 'remove') {
    if (live && tag.host === meId && validGuest(tag.guest)) dismiss(serverId, tag.guest);
    return;
  }
  if (tag.kind === 'textOnly') {
    if (live && m.authorId !== meId && typeof tag.on === 'boolean') setTextOnly(tag.on);
    return;
  }
  if (typeof tag.session !== 'string' || !validRoster(tag.roster)) return;
  const roster: Roster = { session: tag.session, guests: [...new Set(tag.roster)], at: m.createdAt, textOnly: tag.textOnly === true };
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
  if (channelId) void sendTag(channelId, { kind: 'roster', session: SESSION, roster: useGuests.getState().mine[serverId] ?? [], ...textOnlyMark() });
}

/** A guest says reply number `reply`, or line number `chatLine`. `guest` picks who, if they are still here. */
function say(serverId: string, channelId: string, reply?: number, guest?: number, chatLine?: number) {
  const mine = useGuests.getState().mine[serverId] ?? [];
  if (!mine.length) return;
  const who = guest !== undefined && mine.includes(guest) ? guest : mine[Math.floor(Math.random() * mine.length)];
  const line = reply ?? chatLine ?? 0;
  void sendTag(channelId, { kind: 'line', session: SESSION, roster: mine, guest: who, line, reply: reply !== undefined, ...textOnlyMark() });
}

// ---------- hosting ----------

const timers = new Map<string, number[]>();

function later(serverId: string, ms: number, fn: () => void): number {
  const list = timers.get(serverId) ?? [];
  const t = window.setTimeout(() => {
    timers.set(serverId, (timers.get(serverId) ?? []).filter((x) => x !== t));
    if ((useGuests.getState().mine[serverId] ?? []).length) fn();
  }, ms);
  timers.set(serverId, [...list, t]);
  return t;
}

/**
 * channelId -> what guests are about to say there. Newer talk replaces it, so a burst of messages gets one answer
 * rather than a stack of them. `addressed` is true when a guest was called on, which an unaddressed message won't replace;
 * `chat` is true for a conversation guests started among themselves, which any message from a person cuts short.
 */
const queued = new Map<string, { timers: number[]; addressed: boolean; chat: boolean; until: number }>();
/** channelId -> when a person last wrote there. */
const lastHuman = new Map<string, number>();
/** Guests don't start a conversation of their own this soon after a person wrote. */
const QUIET_MS = 30_000;

/** Notes lines a guest will say in a channel, the last one `ms` from now. */
function queue(channelId: string, kind: 'chat' | 'reply' | 'called', ts: number[], ms: number) {
  queued.set(channelId, { timers: ts, addressed: kind === 'called', chat: kind === 'chat', until: Date.now() + ms });
}

/** What guests are still about to say in a channel, if anything. */
function pending(channelId: string) {
  const q = queued.get(channelId);
  if (q && q.until > Date.now()) return q;
  queued.delete(channelId);
  return undefined;
}

/** Drops what guests were about to say in a channel. */
function hush(channelId: string) {
  const q = pending(channelId);
  if (!q) return;
  queued.delete(channelId);
  for (const t of q.timers) window.clearTimeout(t);
  for (const [serverId, list] of timers) timers.set(serverId, list.filter((t) => !q.timers.includes(t)));
}

function stopHosting(serverId: string) {
  for (const t of timers.get(serverId) ?? []) window.clearTimeout(t);
  timers.delete(serverId);
}

/** Conversations started lately, so the same one does not come back soon. */
const recentChats: number[] = [];

/** Guests start a short conversation among themselves: each line by a different guest than the one before. */
function converse(serverId: string, channelId: string) {
  // Don't talk over people: skip while a reply is on its way or someone wrote here lately.
  if (pending(channelId) || Date.now() - (lastHuman.get(channelId) ?? 0) < QUIET_MS) return;
  const fresh = CHATTER_CHATS.map((_, i) => i).filter((i) => !recentChats.includes(i));
  const n = fresh[Math.floor(Math.random() * fresh.length)];
  recentChats.push(n);
  if (recentChats.length > Math.floor(CHATTER_CHATS.length / 2)) recentChats.shift();
  const mine = useGuests.getState().mine[serverId] ?? [];
  const lines = mine.length > 1 ? chatterChat(n) : chatterChat(n).slice(0, 1);
  let at = 0;
  let speaker = -1;
  const ts: number[] = [];
  for (const line of lines) {
    const others = mine.filter((g) => g !== speaker);
    const guest = others[Math.floor(Math.random() * others.length)];
    speaker = guest;
    at += at ? chatterWait(CHATTER_TIMING.replyPause) + chatterWait(CHATTER_TIMING.replyTyping) : 0;
    ts.push(later(serverId, at, () => say(serverId, channelId, undefined, guest, line)));
  }
  queue(channelId, 'chat', ts, at);
}

/** A short conversation in a random text channel now and then, and clips in our call. */
function startHosting(serverId: string) {
  const textLoop = () => {
    const channels = textChannels(serverId);
    if (channels.length) converse(serverId, channels[Math.floor(Math.random() * channels.length)]);
    later(serverId, chatterWait(CHATTER_TIMING.nextChat), textLoop);
  };
  later(serverId, chatterWait(CHATTER_TIMING.firstLine), textLoop);
  const voiceLoop = () => {
    // the next clip does not wait for this one to end, so guests can talk over each other
    void speak(serverId).then(() => later(serverId, chatterWait(CHATTER_TIMING.nextClip), voiceLoop));
  };
  later(serverId, chatterWait(CHATTER_TIMING.firstClip), voiceLoop);
}

/**
 * Someone wrote in a text channel: one guest answers with a reply that fits the words, and sometimes a second guest
 * chimes in. A guest replied to, mentioned or called by name answers themselves; otherwise one host answers for everyone,
 * and only when a topic fits (no filler). A newer message replaces a reply still on its way, so a burst of messages
 * gets one answer, except that a guest who was called on still answers the one who called.
 */
function answer(serverId: string, channelId: string, payload: MessagePayload) {
  lastHuman.set(channelId, Date.now());
  const meId = useSession.getState().user?.id;
  const seats = currentSeats(serverId);
  if (!seats.length || !meId) return;
  const text = chatterText(payload);
  // A guest replied to, @mentioned or called by name answers.
  const addressed = [payload.replyTo?.authorId, ...(payload.mentions?.userIds ?? [])];
  const named = seats.find((s) => addressed.includes(GUEST_USERS[s.guest]?.id))
    ?? seats[chatterNamed(text, seats.map((s) => GUEST_USERS[s.guest]?.displayName ?? ''))];
  const host = named ? named.host : [...new Set(seats.map((s) => s.host))].sort()[0];
  if (host !== meId) return;
  const mine = useGuests.getState().mine[serverId] ?? [];
  if (!mine.length) return;
  if (pending(channelId)?.addressed && !named) return;
  const first = chatterReply(text, recent);
  if (!named && !first.matched) {
    // Nothing fitting to say, but a reply already on its way to an earlier message still goes out.
    if (pending(channelId)?.chat) hush(channelId);
    return;
  }
  hush(channelId);
  remember(first.line);
  const firstGuest = named?.guest ?? mine[Math.floor(Math.random() * mine.length)];
  const wait = chatterWait(CHATTER_TIMING.replyPause) + chatterWait(CHATTER_TIMING.replyTyping);
  const ts = [later(serverId, wait, () => say(serverId, channelId, first.line, firstGuest))];
  // Now and then a second guest chimes in on the same topic, so it feels like a group (not when one was called on).
  if (!named && mine.length > 1 && Math.random() < CHIME_IN) {
    const second = chatterReply(text, recent);
    remember(second.line);
    const wait2 = wait + chatterWait(CHATTER_TIMING.replyPause) + chatterWait(CHATTER_TIMING.replyTyping);
    ts.push(later(serverId, wait2, () => {
      const others = (useGuests.getState().mine[serverId] ?? []).filter((g) => g !== firstGuest);
      say(serverId, channelId, second.line, others[Math.floor(Math.random() * others.length)]);
    }));
    queue(channelId, 'reply', ts, wait2);
  } else queue(channelId, named ? 'called' : 'reply', ts, wait);
}

/** How often a second guest also answers. */
const CHIME_IN = 0.3;
/** Replies sent lately, so guests do not repeat themselves. */
const recent: number[] = [];
function remember(line: number) {
  recent.push(line);
  if (recent.length > 12) recent.shift();
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

/** Marks our rosters so other apps leave our guests out of voice too. */
function textOnlyMark(): { textOnly?: true } {
  return useGuests.getState().textOnly ? { textOnly: true } : {};
}

/** Our guests leave voice (or come back). Each host decides for its own guests and tells everyone in its roster. */
function setTextOnly(on: boolean) {
  if (useGuests.getState().textOnly === on) return;
  useGuests.setState({ textOnly: on });
  try { localStorage.setItem(TEXT_ONLY_KEY, on ? '1' : '0'); } catch { /* not remembered then */ }
  if (on) stopVoice();
  for (const serverId of Object.keys(useGuests.getState().mine)) {
    if (useGuests.getState().mine[serverId]?.length) sendRoster(serverId);
  }
}

/** Switches every guest on the server to text only, or back into voice: ours here, other hosts' by asking them. */
function toggleTextOnly(serverId: string) {
  const seats = currentSeats(serverId);
  const on = seats.length ? !seats.every((s) => s.textOnly) : !useGuests.getState().textOnly;
  setTextOnly(on);
  const meId = useSession.getState().user?.id;
  const channelId = textChannels(serverId)[0];
  if (channelId && seats.some((s) => s.host !== meId)) void sendTag(channelId, { kind: 'textOnly', on });
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
 * While we are in a call, one of our guests that is not already talking plays a recording (if all are talking,
 * this turn is skipped). The call's data channel tells everyone else in the call which guest and which recording,
 * and each app plays it as that guest.
 */
async function speak(serverId: string): Promise<void> {
  const { room, status } = useVoice.getState();
  if (useVoice.getState().serverId !== serverId || status !== 'connected' || !room || useGuests.getState().textOnly) return;
  const audio = await clipList();
  if (!audio) return;
  const idle = (useGuests.getState().mine[serverId] ?? []).filter((g) => {
    const user = GUEST_USERS[g];
    return user && !playing.has(user.id);
  });
  if (!idle.length) return;
  const clip = chatterClip(audio.list.length, lastClip);
  lastClip = clip;
  const guest = idle[Math.floor(Math.random() * idle.length)];
  void room.localParticipant
    .publishData(new TextEncoder().encode(JSON.stringify({ guest, clip })), { reliable: true, topic: CLIP_TOPIC })
    .catch(() => undefined);
  void play(guest, clip);
}

/** Another host's guest speaks in our call. Only the guest's own host can make it speak. */
function onClipData(payload: Uint8Array, from?: RemoteParticipant, _kind?: unknown, topic?: string) {
  const { serverId } = useVoice.getState();
  if (topic !== CLIP_TOPIC || !from || !serverId) return;
  let msg: { guest?: unknown; clip?: unknown };
  try { msg = JSON.parse(new TextDecoder().decode(payload)) as typeof msg; } catch { return; }
  if (!validGuest(msg.guest) || !Number.isInteger(msg.clip)) return;
  const guest = msg.guest;
  if (!currentSeats(serverId).some((s) => s.guest === guest && s.host === from.identity && !s.textOnly)) return;
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

/** Typed in the main window, outside any text box: - - - + adds, + + + - removes, - + - + switches text only on or off. */
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
    } else if (typed === '-+-+') {
      typed = '';
      if (serverId) toggleTextOnly(serverId);
    }
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}
