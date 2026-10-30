// Demo voice call: no LiveKit, no token, no server. The real mic is looped back to the speakers,
// the other occupants of the channel take turns playing
// short bundled recordings, and camera/screen are local previews.
// Nothing is published anywhere. Outgoing audio stays inside voiceAudio, so mute, deafen, master
// volume, output device and the soundboard behave as they do in a real call.
import { CHATTER_TIMING, chatterClip, chatterWait } from '@chatward/shared';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { attachRemote, detachRemote, openMic, startPlayback } from '../state/voiceAudio';
import { VOICE_CLIPS } from './voiceClips';

const SELF_KEY = 'demo:self';
const TONE_USER = 'demo:tone';

interface Bot {
  say: (clip: AudioBuffer, onDone: () => void) => void;
  stop: () => void;
}

interface Call {
  channelId: string;
  selfId: string;
  ctx: AudioContext;
  mic: MediaStreamTrack | null;
  bots: Map<string, Bot>;
  camera: MediaStream | null;
  screen: MediaStream | null;
  loopback: boolean;
  onSpeaking: (ids: string[]) => void;
  unsubscribe: () => void;
  clips: AudioBuffer[];
  lastClip: number;
  chatterTimer?: number;
}

let call: Call | null = null;
const talking = new Set<string>();
let toneSeq = 0;

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

function publishSpeaking(): void {
  call?.onSpeaking([...talking]);
}

/** One source per other occupant. It stays silent until the chatter loop hands it a clip. */
function startBot(userId: string, ctx: AudioContext): Bot {
  const key = `demo:bot:${userId}`;
  const dest = ctx.createMediaStreamDestination();
  const level = ctx.createGain();
  level.gain.value = 0.9;
  level.connect(dest);
  attachRemote(key, userId, dest.stream.getAudioTracks()[0]);

  let playing: AudioBufferSourceNode | null = null;
  let done: (() => void) | null = null;
  return {
    say: (clip, onDone) => {
      const src = ctx.createBufferSource();
      src.buffer = clip;
      src.connect(level);
      playing = src;
      done = onDone;
      talking.add(userId);
      publishSpeaking();
      src.onended = () => {
        if (playing !== src) return;
        playing = null;
        done = null;
        talking.delete(userId);
        publishSpeaking();
        onDone();
      };
      src.start();
    },
    stop: () => {
      if (playing) {
        playing.onended = null;
        playing.stop();
        playing = null;
      }
      talking.delete(userId);
      detachRemote(key);
      // a chatter leaving mid-clip hands the turn back to the loop
      done?.();
      done = null;
    },
  };
}

/** Decodes the bundled recordings for this call's AudioContext. A clip that fails to decode is skipped. */
export async function loadClips(ctx: AudioContext): Promise<AudioBuffer[]> {
  const decoded = await Promise.all(VOICE_CLIPS.map(async (clip) => {
    try {
      return await ctx.decodeAudioData(base64Bytes(clip));
    } catch {
      return null;
    }
  }));
  return decoded.filter((b): b is AudioBuffer => b !== null);
}

function base64Bytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** After a random pause, a random chatter plays a random recording (never the same one twice in a row), then repeat. */
function scheduleChatter(delayMs = chatterWait(CHATTER_TIMING.nextClip)): void {
  const c = call;
  if (!c) return;
  window.clearTimeout(c.chatterTimer);
  c.chatterTimer = window.setTimeout(() => {
    if (call !== c) return;
    const bots = [...c.bots.values()];
    const clips = c.clips;
    if (!bots.length || !clips.length) {
      scheduleChatter();
      return;
    }
    const pick = chatterClip(clips.length, c.lastClip);
    c.lastClip = pick;
    bots[Math.floor(Math.random() * bots.length)].say(clips[pick], () => {
      if (call === c) scheduleChatter();
    });
  }, delayMs);
}

/** Short rising (join) or falling (leave) two-note chime, played through the call's output path. */
function playTone(kind: 'join' | 'leave'): void {
  if (!call) return;
  const { ctx } = call;
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(dest);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.connect(gain);
  const [first, second] = kind === 'join' ? [523.25, 783.99] : [783.99, 466.16];
  const t = ctx.currentTime;
  osc.frequency.setValueAtTime(first, t);
  osc.frequency.setValueAtTime(second, t + 0.12);
  gain.gain.linearRampToValueAtTime(0.2, t + 0.02);
  gain.gain.setValueAtTime(0.2, t + 0.22);
  gain.gain.linearRampToValueAtTime(0, t + 0.3);
  osc.start(t);
  osc.stop(t + 0.32);
  const key = `demo:tone:${++toneSeq}`;
  attachRemote(key, TONE_USER, dest.stream.getAudioTracks()[0]);
  window.setTimeout(() => detachRemote(key), 600);
}

function addBot(userId: string): void {
  if (!call || call.bots.has(userId)) return;
  call.bots.set(userId, startBot(userId, call.ctx));
}

function removeBot(userId: string): void {
  call?.bots.get(userId)?.stop();
  call?.bots.delete(userId);
  talking.delete(userId);
}

function setLoopbackPath(on: boolean): void {
  if (!call) return;
  if (on && call.mic) attachRemote(SELF_KEY, SELF_KEY, call.mic);
  else detachRemote(SELF_KEY);
}

export const demoVoice = {
  /** Call after startPlayback-ready UI gesture; sets up the mic loopback and one bot per other occupant. */
  async join(channelId: string, selfId: string, opts: { loopback: boolean; onSpeaking: (ids: string[]) => void }): Promise<void> {
    // created before any await so the browser counts it as part of the click
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await startPlayback();
    const mic = await openMic();

    const unsubscribe = useSession.subscribe((s, prev) => {
      if (!call) return;
      const now = s.voiceOccupants[channelId] ?? [];
      const before = prev.voiceOccupants[channelId] ?? [];
      if (now.join() === before.join()) return;
      for (const id of now) {
        if (id !== selfId && !before.includes(id)) {
          addBot(id);
          playTone('join');
        }
      }
      for (const id of before) {
        if (id !== selfId && !now.includes(id)) {
          removeBot(id);
          playTone('leave');
        }
      }
    });

    call = {
      channelId, selfId, ctx, mic, bots: new Map(), camera: null, screen: null,
      loopback: opts.loopback, onSpeaking: opts.onSpeaking, unsubscribe, clips: [], lastClip: -1,
    };
    setLoopbackPath(opts.loopback);
    for (const id of useSession.getState().voiceOccupants[channelId] ?? []) {
      if (id !== selfId) addBot(id);
    }
    const c = call;
    void loadClips(ctx).then((clips) => {
      c.clips = clips;
    });
    scheduleChatter(chatterWait(CHATTER_TIMING.firstClip));
  },

  leave(): void {
    const c = call;
    if (!c) return;
    call = null;
    c.unsubscribe();
    window.clearTimeout(c.chatterTimer);
    for (const bot of c.bots.values()) bot.stop();
    talking.clear();
    stopTracks(c.camera);
    stopTracks(c.screen);
    void c.ctx.close();
  },

  setLoopback(on: boolean): void {
    if (!call) return;
    call.loopback = on;
    setLoopbackPath(on);
  },

  async setCamera(on: boolean): Promise<void> {
    if (!call) return;
    if (!on) {
      stopTracks(call.camera);
      call.camera = null;
      return;
    }
    const deviceId = useSettings.getState().cameraDeviceId;
    call.camera = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true });
  },

  /** sourceId from window.chatward.getScreenSources(); onEnded fires when the OS stops the share. */
  async setScreen(on: boolean, sourceId?: string, onEnded?: () => void): Promise<void> {
    if (!call) return;
    if (!on) {
      stopTracks(call.screen);
      call.screen = null;
      return;
    }
    if (!sourceId) throw new Error('No screen or window selected');
    // the main process reads the selected source when getDisplayMedia runs, so select it first
    await window.chatward.selectScreenSource(sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (call?.screen !== stream) return;
      call.screen = null;
      onEnded?.();
    });
    if (!call) {
      stopTracks(stream);
      return;
    }
    call.screen = stream;
  },

  /** Local previews for the tiles. Null when no demo call is running. */
  snapshot(): { camera: MediaStream | null; screen: MediaStream | null } {
    return { camera: call?.camera ?? null, screen: call?.screen ?? null };
  },
};
