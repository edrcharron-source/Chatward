// Voice call state (voice-core). Joins a LiveKit room; media is E2EE with a key derived from the channel key.
import { create } from 'zustand';
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track, type Participant } from 'livekit-client';
import { DEFAULT_VOICE_BITRATE_KBPS, VOICE_BITRATES_KBPS, type Channel } from '@chatward/shared';
import { api } from '../api/http';
import { voiceKey } from '../crypto';
import { startCamera, stopCamera, startScreen, stopScreen } from '../components/voice/media';
import { attachRemote, closeAudio, detachRemote, micLevel, openMic, setDeafened, setTransmitting, startPlayback } from './voiceAudio';
import { useSession } from './session';
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
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setDemoLoopback: (on: boolean) => void;
  /** implemented in components/voice/media.ts and wired in below */
  setCamera: (on: boolean) => Promise<void>;
  setScreen: (on: boolean, sourceId?: string) => Promise<void>;
  setTheater: (key: string | null) => void;
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
let activeKeyProvider: ExternalE2EEKeyProvider | null = null;
let activeKeyId = '';

const keyBuffer = (key: Uint8Array): ArrayBuffer => key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
const keyId = (key: Uint8Array): string => Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Call after a group changes (a member removed, or another device's Commit applied). The MLS epoch moves on, which
 * changes the call key, so the people still in the call switch to it. A removed member cannot derive the new key.
 */
export async function rekeyActiveCall(): Promise<void> {
  const { channelId, status } = useVoice.getState();
  if (!activeKeyProvider || !channelId || status !== 'connected') return;
  const key = await voiceKey(channelId);
  if (!key || keyId(key) === activeKeyId) return;
  activeKeyId = keyId(key);
  await activeKeyProvider.setKey(keyBuffer(key));
}

// Bumps on every join and leave. A join still connecting when this has moved on is stale and tears down what it built.
let joinAttempt = 0;

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
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
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
      .on(RoomEvent.Reconnected, () => { if (current()) set({ status: 'connected' }); })
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
  async function hangUp(): Promise<void> {
    const { room, channelId } = get();
    if (!channelId) return;
    set({ room: null, channelId: null, serverId: null, status: 'idle', error: null, cameraOn: false, screenOn: false, theaterKey: null, speaking: [], notice: null });
    endMeter();
    closeAudio();
    demoVoice.leave(); // no-op outside a demo call
    if (room) await room.disconnect();
    if (isDemo()) return;
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
        const key = await voiceKey(channelId);
        if (stale()) { abandon(channelId, room, mic); return; }
        if (!key) throw new Error('Channel encryption key is not available yet');
        const { url, token } = await api.post<{ url: string; token: string }>('/api/voice/token', { channelId });
        if (stale()) { abandon(channelId, room, mic); return; }

        const keyProvider = new ExternalE2EEKeyProvider();
        await keyProvider.setKey(keyBuffer(key));
        if (stale()) { abandon(channelId, room, mic); return; }
        activeKeyProvider = keyProvider;
        activeKeyId = keyId(key);
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

        mic = await openMic();
        if (stale()) { abandon(channelId, room, mic); return; }
        const bitrate = channelBitrate(useSession.getState().servers.flatMap((b) => b.channels).find((c) => c.id === channelId));
        await room.localParticipant.publishTrack(mic, { source: Track.Source.Microphone, ...micPublish(bitrate) });
        if (stale()) { abandon(channelId, room, mic); return; }
        set({ status: 'connected' });
        syncMic();
        startMeter();
      } catch (e) {
        // errors from a superseded join belong to it; the newer call owns the state and audio
        if (stale()) { abandon(channelId, room, mic); return; }
        endMeter();
        closeAudio();
        void room?.disconnect();
        set({ room: null, status: 'error', error: e instanceof Error ? e.message : String(e), speaking: [] });
        // the server may already count us in this channel
        void api.post('/api/voice/leave', { channelId }).catch(() => {});
      }
    },

    leave: async () => {
      ++joinAttempt; // also cancels a join that is still connecting
      await hangUp();
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

// Leave the call when the user logs out (or is signed out by a 401).
useSession.subscribe((s, prev) => {
  if (prev.token && !s.token) void useVoice.getState().leave();
});

// An admin changed this channel's bitrate: apply it to the live call.
useSession.subscribe((s, prev) => {
  const { channelId, room } = useVoice.getState();
  if (!channelId || !room) return;
  const find = (st: typeof s) => st.servers.flatMap((b) => b.channels).find((c) => c.id === channelId);
  const next = channelBitrate(find(s));
  if (next === channelBitrate(find(prev))) return;
  applyBitrate(room, next).catch((e) => console.warn('bitrate change failed', e));
});
