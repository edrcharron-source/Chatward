// Voice call state (voice-core). Joins a LiveKit room; media is E2EE with a key derived from the channel key.
import { create } from 'zustand';
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track, type Participant } from 'livekit-client';
import { DEFAULT_VOICE_BITRATE_KBPS, VOICE_BITRATES_KBPS, type Channel } from '@chatward/shared';
import { api, ApiError, postOnUnload } from '../api/http';
import { onEpochChange, voiceKey } from '../crypto';
import { startCamera, stopCamera, startScreen, stopScreen, switchCamera } from '../components/voice/media';
import { attachRemote, closeAudio, detachRemote, micLevel, openMic, setDeafened, setTransmitting, setVoiceNotifier, startPlayback } from './voiceAudio';
import { onBeforeSignOut, useSession } from './session';
import { useSettings } from './settings';
import { demoVoice } from '../demo/voice';
import { isDemo } from '../demo';

export interface VoiceState {
  channelId: string | null;
  serverId: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  room: Room | null;
  muted: boolean;
  deafened: boolean;
  /** demo only: hear your own mic through the speakers */
  demoLoopback: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  /** the screen share shown in theater mode, as `${userId}:screen`; null when theater mode is off */
  theaterKey: string | null;
  /** userIds currently speaking */
  speaking: string[];
  /** bumps on any room change so views re-read participants and tracks */
  version: number;
  /** a short note shown after a call ends for a reason the user did not choose, e.g. a kick; cleared on the next join */
  notice: string | null;
  join: (serverId: string, channelId: string) => Promise<void>;
  /** Hangs up. Pass false to skip the server's leave call, for when the token is gone. */
  leave: (notifyServer?: boolean) => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setDemoLoopback: (on: boolean) => void;
  /** implemented in components/voice/media.ts and wired in below */
  setCamera: (on: boolean) => Promise<void>;
  setScreen: (on: boolean, sourceId?: string) => Promise<void>;
  setTheater: (key: string | null) => void;
}

// Waits before each retry of a rejoin that failed for a reason other than the server refusing the slot. A rejoin that
// LiveKit says is not in the room is retried on this schedule before we hang up.
const REJOIN_RETRY_MS = [3_000, 6_000, 12_000];
// LiveKit's admin API failing (503) says nothing about the media, so the call stays up. Keep retrying every 30 seconds
// for as long as the call is up, since the server slot is gone until a rejoin succeeds. Tell the person once it has
// gone on for about 5 minutes.
const LOOKUP_RETRY_MS = 30_000;
const LOOKUP_NOTICE_TRIES = 10;
const LOOKUP_NOTICE = 'Voice server is not responding. Retrying until it recovers';
let rejoinRetry: ReturnType<typeof setTimeout> | undefined;
// Counts resumeVoiceSlot calls. A rejoin POST still in flight when a newer call starts (a reconnect during an outage)
// must do nothing when it returns, or it would start a second retry chain next to the new one.
let rejoinGeneration = 0;

/**
 * Called when the websocket reconnects. If we are still in a call, the server may have lost our voice slot (it is
 * in memory, so a restart clears it). Put the slot back so others see us and kicks reach us. The media is untouched.
 * If the server refuses (we were removed, lost access, or the call moved to another device), hang up: the call is no
 * longer ours on the server.
 * The two kinds of retry have their own counters: a LiveKit lookup outage must not use up the "not in the room" tries.
 */
export function resumeVoiceSlot(retryTries = 0, lookupTries = 0): void {
  clearTimeout(rejoinRetry);
  const generation = ++rejoinGeneration;
  const { channelId, room } = useVoice.getState();
  if (!channelId || !room || isDemo()) return;
  const isStale = () => generation !== rejoinGeneration || useVoice.getState().room !== room;
  // The server clears mute and deafen state along with the slot. Send ours with the rejoin, or a muted person could play
  // soundboard sounds until their next mute toggle. Read the state now, not when the call started.
  const { muted, deafened } = useVoice.getState();
  void api.post('/api/voice/rejoin', { channelId, muted, deafened })
    .then(() => {
      // The slot is back, so the "not responding" notice from an earlier outage no longer applies.
      if (!isStale() && useVoice.getState().notice === LOOKUP_NOTICE) useVoice.setState({ notice: null });
    }, (e) => {
      if (isStale()) return;
      console.warn('could not restore voice slot', e);
      const lookupDown = e instanceof ApiError && e.status === 503;
      const notInRoom = e instanceof ApiError && e.status === 409 && e.code === 'not_in_room';
      const refused = e instanceof ApiError && !lookupDown && !notInRoom && [403, 404, 409].includes(e.status);
      if (!refused) {
        // A 503 says nothing about the media, so keep retrying on the slow schedule while the call goes on.
        if (lookupDown) {
          if (lookupTries === LOOKUP_NOTICE_TRIES) useVoice.setState({ notice: LOOKUP_NOTICE });
          rejoinRetry = setTimeout(() => {
            if (useVoice.getState().room === room) resumeVoiceSlot(retryTries, lookupTries + 1);
          }, LOOKUP_RETRY_MS);
          return;
        }
        // A timeout, network error, 429 or 500 says nothing about the slot, so try again on the fast schedule first.
        const delay = REJOIN_RETRY_MS[retryTries];
        if (delay !== undefined) {
          rejoinRetry = setTimeout(() => {
            if (useVoice.getState().room === room) resumeVoiceSlot(retryTries + 1, lookupTries);
          }, delay);
          return;
        }
        // Out of fast tries. Only "not in the room" hangs up, since that call is not coming back. Anything else keeps
        // the call going on the slow schedule until a rejoin gets through.
        if (!notInRoom) {
          rejoinRetry = setTimeout(() => {
            if (useVoice.getState().room === room) resumeVoiceSlot(retryTries, lookupTries + 1);
          }, LOOKUP_RETRY_MS);
          return;
        }
      }
      // Skip the leave call: the server has already refused this slot, so it would be refused again.
      const notice = e.status === 409 && e.message.includes('another device')
        ? 'The call moved to another device'
        : 'You are no longer in this call';
      void useVoice.getState().leave(false)
        .then(() => useVoice.setState({ notice }))
        .catch((err) => console.error(err));
    });
}

/**
 * First connection after the app starts. Nothing is in a call yet, so any slot the server still holds for this account
 * is left over from a restart or crash. Clear it, or the "already in this call on another device" check locks us out.
 */
export function clearLeftoverVoiceSlot(): void {
  if (useVoice.getState().channelId || isDemo()) return;
  leftoverClear = api.post('/api/voice/clear').then(() => {}, (e) => console.warn('could not clear leftover voice slot', e));
}

/**
 * The window is closing, or the app is about to restart to update: end the call now so the server does not keep the slot.
 * Best effort. If the page unloads first, the server's grace timer and the startup clear still cover it.
 */
export function leaveCallOnExit(): void {
  const { channelId } = useVoice.getState();
  if (!channelId || isDemo()) return;
  postOnUnload('/api/voice/leave', { channelId });
  void useVoice.getState().leave();
}

/** The channel's bitrate, or the default when unset or not one of the allowed values. */
export function channelBitrate(channel: Channel | undefined): number {
  const kbps = channel?.bitrateKbps;
  return kbps !== undefined && (VOICE_BITRATES_KBPS as readonly number[]).includes(kbps) ? kbps : DEFAULT_VOICE_BITRATE_KBPS;
}

// DTX stops sending packets while silent.
const micPublish = (kbps: number) => ({ dtx: true, red: false, audioPreset: { maxBitrate: kbps * 1000 } });

/** Changes the live mic sender's ceiling without republishing the track. */
async function applyBitrate(room: Room, kbps: number): Promise<void> {
  const sender = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings.length) return;
  params.encodings[0].maxBitrate = kbps * 1000;
  await sender.setParameters(params);
}

const bump = () => useVoice.setState((s) => ({ version: s.version + 1 }));

// Key provider of the call in progress, and the key it currently holds, so a group change can set a new key only when it differs.
let activeKeyProvider: IndexedKeyProvider | null = null;
let activeKeyId = '';

// LiveKit keeps one key per index. ExternalE2EEKeyProvider.setKey always writes index 0 and overwrites it, so a call that
// switched keys dropped every frame still encrypted with the old one. Each key goes to the slot of its MLS epoch, so the
// slot is the same on every device. A per-device counter would differ for anyone who joined after an epoch change. The
// previous epoch's key stays in its own slot until the ring wraps, so frames already in flight still decrypt.
const KEY_RING_SIZE = 16;

class IndexedKeyProvider extends ExternalE2EEKeyProvider {
  constructor() {
    super({ keyringSize: KEY_RING_SIZE });
  }

  async setIndexedKey(key: ArrayBuffer, epoch: bigint): Promise<void> {
    const material = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits', 'deriveKey']);
    this.onSetEncryptionKey(material, undefined, Number(epoch % BigInt(KEY_RING_SIZE)));
  }
}

const keyBuffer = (key: Uint8Array): ArrayBuffer => key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
const keyId = (key: Uint8Array): string => Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');

// Rekeys run one at a time. Each reads the current key when its turn comes, so an older slow setKey cannot land last.
let rekeyQueue: Promise<void> = Promise.resolve();

/**
 * Switch the call to the current channel key if it has changed. The MLS epoch moves on with every Commit, which changes
 * the call key, so the people still in the call switch to it. A removed member cannot derive the new key.
 */
export function rekeyActiveCall(): Promise<void> {
  const run = rekeyQueue.then(applyCallKey);
  rekeyQueue = run.catch(() => {});
  return run;
}

async function applyCallKey(): Promise<void> {
  const { channelId, status } = useVoice.getState();
  if (!activeKeyProvider || !channelId || status !== 'connected') return;
  const voice = await voiceKey(channelId);
  if (!voice || keyId(voice.key) === activeKeyId) return;
  await activeKeyProvider.setIndexedKey(keyBuffer(voice.key), voice.epoch);
  activeKeyId = keyId(voice.key);
}

// Every epoch move rekeys a live call, whichever path moved it (our Commit, another device's, a Welcome, a catch-up).
onEpochChange(() => void rekeyActiveCall().catch((e) => console.warn('rekey after epoch change failed', e)));

// Bumps on every join and leave. A join still connecting when this has moved on is stale and tears down what it built.
let joinAttempt = 0;
// The startup clear must land before a join takes a slot, or the clear could drop the slot the join just took.
let leftoverClear: Promise<void> = Promise.resolve();

// Your own speaking state comes from your mic level, so it works without LiveKit's active-speaker data.
const METER_MS = 100;
const SPEAK_LEVEL = 0.01;
const SPEAK_HOLD_MS = 400;
let selfTalking = false;
let lastLoud = 0;
let meterTimer: number | undefined;

/** The speaking list for remote voices, with the local user placed by the mic meter. */
function speakingList(others: string[]): string[] {
  const selfId = useSession.getState().user?.id;
  const rest = others.filter((id) => id !== selfId);
  return selfTalking && selfId ? [...rest, selfId] : rest;
}

function startMeter(): void {
  endMeter();
  meterTimer = window.setInterval(() => {
    const now = performance.now();
    if (micLevel() >= SPEAK_LEVEL) lastLoud = now;
    const talking = now - lastLoud < SPEAK_HOLD_MS;
    if (talking === selfTalking) return;
    selfTalking = talking;
    useVoice.setState((s) => ({ speaking: speakingList(s.speaking) }));
  }, METER_MS);
}

function endMeter(): void {
  window.clearInterval(meterTimer);
  meterTimer = undefined;
  selfTalking = false;
}

export const useVoice = create<VoiceState>((set, get) => {
  /** muted and deafened both close the mic path; deafening also silences playback */
  function syncMic(): void {
    const { muted, deafened, room, channelId } = get();
    const open = !muted && !deafened;
    setDeafened(deafened);
    setTransmitting(open);
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (track) void (open ? track.unmute() : track.mute()).catch(() => {});
    // The server uses this to refuse soundboard plays from muted or deafened users.
    if (channelId && !isDemo()) void api.post('/api/voice/state', { channelId, muted, deafened }).catch(() => {});
  }

  function wire(room: Room): void {
    const current = () => get().room === room;
    room
      .on(RoomEvent.ParticipantConnected, bump)
      .on(RoomEvent.ParticipantDisconnected, bump)
      .on(RoomEvent.TrackPublished, bump)
      .on(RoomEvent.TrackUnpublished, bump)
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // the OS stop-sharing bar ends the track without our buttons, so clear their state here too
        if (current() && pub.source === Track.Source.ScreenShare) set({ screenOn: false });
        if (current() && pub.source === Track.Source.Camera) set({ cameraOn: false });
        bump();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        // turning the camera off mutes its publication rather than unpublishing it, so clear our state here too
        if (current() && p === room.localParticipant && pub.source === Track.Source.Camera) set({ cameraOn: false });
        bump();
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (current() && p === room.localParticipant && pub.source === Track.Source.Camera) set({ cameraOn: true });
        bump();
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        if (current() && track.kind === Track.Kind.Audio) attachRemote(pub.trackSid, p.identity, track.mediaStreamTrack);
        bump();
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, pub) => {
        detachRemote(pub.trackSid);
        bump();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (current()) set({ speaking: speakingList(speakers.map((p) => p.identity)) });
      })
      .on(RoomEvent.Reconnecting, () => { if (current()) set({ status: 'connecting' }); })
      .on(RoomEvent.Reconnected, () => {
        if (!current()) return;
        set({ status: 'connected' });
        // the group may have moved on while the call was reconnecting, which rekeyActiveCall skipped
        void rekeyActiveCall().catch((e) => console.warn('rekey after reconnect failed', e));
      })
      .on(RoomEvent.Disconnected, () => {
        if (!current()) return; // our own leave() already cleaned up
        endMeter();
        closeAudio();
        set({ room: null, status: 'error', error: 'Voice connection lost', speaking: [], cameraOn: false, screenOn: false });
        const channelId = get().channelId;
        if (channelId) void api.post('/api/voice/leave', { channelId }).catch(() => {});
      });
  }

  /** Ends the current call. State is cleared first so the old room's events are ignored. */
  async function hangUp(notifyServer = true): Promise<void> {
    const { room, channelId } = get();
    if (!channelId) return;
    set({ room: null, channelId: null, serverId: null, status: 'idle', error: null, cameraOn: false, screenOn: false, theaterKey: null, speaking: [], notice: null });
    activeKeyProvider = null;
    activeKeyId = '';
    endMeter();
    closeAudio();
    demoVoice.leave(); // no-op outside a demo call
    if (room) await room.disconnect();
    if (!notifyServer || isDemo()) return;
    await api.post('/api/voice/leave', { channelId }).catch(() => {});
  }

  /** A superseded join drops what it built, but leaves the newer call's state and audio alone. */
  function abandon(channelId: string, room: Room | null, mic: MediaStreamTrack | null): void {
    mic?.stop();
    void room?.disconnect();
    // the token request may have counted us in this channel; skip this if the user is back in it
    if (get().channelId !== channelId) void api.post('/api/voice/leave', { channelId }).catch(() => {});
  }

  return {
    channelId: null, serverId: null, status: 'idle', error: null, room: null,
    muted: false, deafened: false, demoLoopback: true, cameraOn: false, screenOn: false, theaterKey: null, speaking: [], version: 0, notice: null,

    join: async (serverId, channelId) => {
      const cur = get();
      if (cur.channelId === channelId && cur.status !== 'error') return;
      // this join supersedes any join or call still in progress
      const attempt = ++joinAttempt;
      const stale = () => attempt !== joinAttempt;
      await hangUp();
      if (stale()) return;
      set({ serverId, channelId, status: 'connecting', error: null, cameraOn: false, screenOn: false, speaking: [] });

      if (isDemo()) {
        try {
          const selfId = useSession.getState().user?.id ?? 'you';
          await demoVoice.join(channelId, selfId, { loopback: get().demoLoopback, onSpeaking: (ids) => set({ speaking: speakingList(ids) }) });
          set({ status: 'connected' });
          syncMic();
          startMeter();
        } catch (e) {
          demoVoice.leave();
          endMeter();
          closeAudio();
          set({ channelId: null, serverId: null, status: 'error', error: e instanceof Error ? e.message : String(e), speaking: [] });
        }
        return;
      }

      // Each step checks stale() after its await: a leave or newer join during connect must not leave a live room or mic behind.
      let room: Room | null = null;
      let mic: MediaStreamTrack | null = null;
      try {
        // Fail closed: never join a call without the channel key.
        const voice = await voiceKey(channelId);
        if (stale()) { abandon(channelId, room, mic); return; }
        if (!voice) throw new Error('Channel encryption key is not available yet');
        await leftoverClear;
        if (stale()) { abandon(channelId, room, mic); return; }
        // The server needs the mute state now, so a muted person is silenced for soundboard from the first moment.
        const { muted, deafened } = get();
        const { url, token } = await api.post<{ url: string; token: string }>('/api/voice/token', { channelId, muted, deafened });
        if (stale()) { abandon(channelId, room, mic); return; }

        const keyProvider = new IndexedKeyProvider();
        await keyProvider.setIndexedKey(keyBuffer(voice.key), voice.epoch);
        if (stale()) { abandon(channelId, room, mic); return; }
        activeKeyProvider = keyProvider;
        activeKeyId = keyId(voice.key);
        const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
        room = new Room({ adaptiveStream: true, dynacast: true, e2ee: { keyProvider, worker } });
        wire(room);
        // the store must know the room before connect, or the event guards drop early tracks
        set({ room });

        // Playback starts before connect so remote tracks that arrive during connect are heard.
        await startPlayback();
        if (stale()) { abandon(channelId, room, mic); return; }
        await room.connect(url, token);
        if (stale()) { abandon(channelId, room, mic); return; }
        await room.setE2EEEnabled(true);
        if (stale()) { abandon(channelId, room, mic); return; }

        mic = await openMic(!muted && !deafened);
        if (stale()) { abandon(channelId, room, mic); return; }
        const bitrate = channelBitrate(useSession.getState().servers.flatMap((b) => b.channels).find((c) => c.id === channelId));
        await room.localParticipant.publishTrack(mic, { source: Track.Source.Microphone, ...micPublish(bitrate) });
        if (stale()) { abandon(channelId, room, mic); return; }
        set({ status: 'connected' });
        // a group change during connect was skipped (status was 'connecting'), so check the key once connected
        void rekeyActiveCall().catch((e) => console.warn('rekey after join failed', e));
        syncMic();
        startMeter();
      } catch (e) {
        // errors from a superseded join belong to it; the newer call owns the state and audio
        if (stale()) { abandon(channelId, room, mic); return; }
        endMeter();
        closeAudio();
        void room?.disconnect();
        set({ room: null, status: 'error', error: e instanceof Error ? e.message : String(e), speaking: [] });
        // the server may already count us in this channel. A 409 means another device holds the slot, so leave it alone.
        if (!(e instanceof ApiError && e.status === 409)) void api.post('/api/voice/leave', { channelId }).catch(() => {});
      }
    },

    leave: async (notifyServer = true) => {
      ++joinAttempt; // also cancels a join that is still connecting
      await hangUp(notifyServer);
    },

    toggleMute: () => {
      if (get().deafened) return; // can't unmute while deafened
      set({ muted: !get().muted });
      syncMic();
    },

    setDemoLoopback: (on) => {
      set({ demoLoopback: on });
      demoVoice.setLoopback(on);
    },

    // deafen implies mute; undeafening unmutes, as Discord does
    setTheater: (key) => set({ theaterKey: key }),

    toggleDeafen: () => {
      const deafened = !get().deafened;
      set({ deafened, muted: deafened });
      syncMic();
    },

    setCamera: async (on) => {
      if (isDemo()) {
        await demoVoice.setCamera(on);
        set({ cameraOn: on });
        bump();
        return;
      }
      const room = get().room;
      if (!room) return;
      if (on) await startCamera(room, useSettings.getState().cameraDeviceId || undefined);
      else await stopCamera(room);
      set({ cameraOn: on });
    },

    setScreen: async (on, sourceId) => {
      if (isDemo()) {
        await demoVoice.setScreen(on, sourceId, () => {
          set({ screenOn: false });
          bump();
        });
        set({ screenOn: on });
        bump();
        return;
      }
      const room = get().room;
      if (!room) return;
      if (on) {
        if (!sourceId) throw new Error('No screen or window selected');
        await startScreen(room, sourceId);
      } else {
        await stopScreen(room);
      }
      set({ screenOn: on });
    },
  };
});

setVoiceNotifier((message) => useVoice.setState({ notice: message }));

// Leave the call on logout (or a 401 sign-out) while the token is still set, so the server accepts the leave.
// After an account delete there is no token left to leave with, so only tear down the local call.
onBeforeSignOut(({ serverAvailable }) => useVoice.getState().leave(serverAvailable));

// An admin changed this channel's bitrate: apply it to the live call.
useSession.subscribe((s, prev) => {
  const { channelId, room } = useVoice.getState();
  if (!channelId || !room) return;
  const find = (st: typeof s) => st.servers.flatMap((b) => b.channels).find((c) => c.id === channelId);
  const next = channelBitrate(find(s));
  if (next === channelBitrate(find(prev))) return;
  applyBitrate(room, next).catch((e) => console.warn('bitrate change failed', e));
});

// A camera picked in Settings: switch the live camera now, if we are sending video.
useSettings.subscribe((s, prev) => {
  if (s.cameraDeviceId === prev.cameraDeviceId) return;
  const { room, cameraOn } = useVoice.getState();
  if (!room || !cameraOn) return;
  switchCamera(room, s.cameraDeviceId)
    .then(() => {
      // the swap unpublishes the old track, which clears cameraOn; read the fresh track's state back
      if (useVoice.getState().room !== room) return;
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      useVoice.setState({ cameraOn: !!pub && !pub.isMuted });
    })
    .catch((e) => console.warn('camera change failed', e));
});
