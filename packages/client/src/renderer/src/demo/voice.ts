// Demo voice call: no LiveKit, no token, no server. The real mic is looped back to the speakers,
// the other occupants of the channel are synthesized voices, and camera/screen are local previews.
// Nothing is published anywhere. Outgoing audio stays inside voiceAudio, so mute, deafen, master
// volume, output device and the soundboard behave as they do in a real call.
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { attachRemote, detachRemote, openMic, startPlayback } from '../state/voiceAudio';

const SELF_KEY = 'demo:self';
const TONE_USER = 'demo:tone';

interface Bot {
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

/** A synthesized, voice-like source: a pitch-wandering buzz through two formant-ish bands, in bursts. */
function startBot(userId: string, ctx: AudioContext): Bot {
  const key = `demo:bot:${userId}`;
  const dest = ctx.createMediaStreamDestination();
  const env = ctx.createGain();
  env.gain.value = 0;
  env.connect(dest);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 95 + Math.random() * 70;
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 4 + Math.random() * 3;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 14;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(osc.frequency);

  const low = ctx.createBiquadFilter();
  low.type = 'bandpass';
  low.frequency.value = 700;
  low.Q.value = 4;
  const high = ctx.createBiquadFilter();
  high.type = 'bandpass';
  high.frequency.value = 1200;
  high.Q.value = 6;
  const highLevel = ctx.createGain();
  highLevel.gain.value = 0.6;
  osc.connect(low);
  osc.connect(high);
  high.connect(highLevel);
  low.connect(env);
  highLevel.connect(env);

  osc.start();
  wobble.start();
  attachRemote(key, userId, dest.stream.getAudioTracks()[0]);

  let syllables: number | undefined;
  let timer: number | undefined;
  const talk = () => {
    talking.add(userId);
    publishSpeaking();
    env.gain.setTargetAtTime(0.2, ctx.currentTime, 0.03);
    syllables = window.setInterval(() => {
      env.gain.setTargetAtTime(0.08 + Math.random() * 0.16, ctx.currentTime, 0.04);
    }, 170);
    timer = window.setTimeout(hush, 1500 + Math.random() * 2500);
  };
  const hush = () => {
    window.clearInterval(syllables);
    talking.delete(userId);
    publishSpeaking();
    env.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    timer = window.setTimeout(talk, 900 + Math.random() * 2600);
  };
  timer = window.setTimeout(talk, 500 + Math.random() * 1500);

  return {
    stop: () => {
      window.clearTimeout(timer);
      window.clearInterval(syllables);
      talking.delete(userId);
      osc.stop();
      wobble.stop();
      detachRemote(key);
    },
  };
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
      loopback: opts.loopback, onSpeaking: opts.onSpeaking, unsubscribe,
    };
    setLoopbackPath(opts.loopback);
    for (const id of useSession.getState().voiceOccupants[channelId] ?? []) {
      if (id !== selfId) addBot(id);
    }
  },

  leave(): void {
    const c = call;
    if (!c) return;
    call = null;
    c.unsubscribe();
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
