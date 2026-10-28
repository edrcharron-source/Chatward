// Audio graphs for a voice call (voice-core).
//   outgoing: mic -> micGain -> mixIn (soundboard connects here) -> micGate -> published track
//   incoming: each remote track -> per-user gain -> master (volume / deafen) -> output device
// Mic and playback use separate AudioContexts so the playback one can take setSinkId.
import { useSettings } from './settings';

export const voiceAudio: {
  ctx: AudioContext | null;
  /** connect extra sources here to send them to everyone in the call (soundboard) */
  mixIn: AudioNode | null;
} = { ctx: null, mixIn: null };

type SinkContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micGain: GainNode | null = null;
let micGate: GainNode | null = null;
let micMeter: AnalyserNode | null = null;
let meterBuf: Float32Array<ArrayBuffer> | null = null;

let playCtx: SinkContext | null = null;
let master: GainNode | null = null;
let deafened = false;
/** keyed by LiveKit track sid */
const remotes = new Map<string, { userId: string; source: MediaStreamAudioSourceNode; gain: GainNode; sink: HTMLAudioElement }>();

// Browser-side processing only: auto gain would fight the mic boost setting.
function captureConstraints(deviceId: string): MediaTrackConstraints {
  const { noiseSuppression, echoCancellation } = useSettings.getState();
  return { deviceId: deviceId ? { exact: deviceId } : undefined, noiseSuppression, echoCancellation, autoGainControl: false };
}

async function getMic(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(deviceId) });
  } catch (e) {
    // saved device is gone (unplugged): fall back to the system default
    if (!deviceId) throw e;
    return navigator.mediaDevices.getUserMedia({ audio: captureConstraints('') });
  }
}

/** Builds the outgoing mic graph and returns the track to publish. */
export async function openMic(): Promise<MediaStreamTrack> {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const gain = ctx.createGain();
  gain.gain.value = useSettings.getState().micGain;
  const mix = ctx.createGain();
  const gate = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  // the meter sits after the gate, so muting and deafening read as silence
  const meter = ctx.createAnalyser();
  meter.fftSize = 512;
  gain.connect(mix);
  mix.connect(gate);
  gate.connect(dest);
  gate.connect(meter);
  voiceAudio.ctx = ctx;
  voiceAudio.mixIn = mix;
  micGain = gain;
  micGate = gate;
  micMeter = meter;
  meterBuf = new Float32Array(meter.fftSize);
  await setInputDevice(useSettings.getState().inputDeviceId);
  return dest.stream.getAudioTracks()[0];
}

/** RMS level (0..1) of the outgoing mic after gain and mute/deafen gating. 0 when no call is open. */
export function micLevel(): number {
  if (!micMeter || !meterBuf) return 0;
  micMeter.getFloatTimeDomainData(meterBuf);
  let sum = 0;
  for (const v of meterBuf) sum += v * v;
  return Math.sqrt(sum / meterBuf.length);
}

/** Swaps the raw mic source feeding the graph; the published track stays the same. */
export async function setInputDevice(deviceId: string): Promise<void> {
  const ctx = voiceAudio.ctx;
  if (!ctx || !micGain) return;
  const stream = await getMic(deviceId);
  // the call may have ended while the permission prompt was open
  if (voiceAudio.ctx !== ctx || !micGain) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  micSource?.disconnect();
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = stream;
  micSource = ctx.createMediaStreamSource(stream);
  micSource.connect(micGain);
}

/** Opens or closes the outgoing mic path. Muting and deafening both close it. */
export function setTransmitting(on: boolean): void {
  if (!voiceAudio.ctx || !micGate) return;
  micGate.gain.setTargetAtTime(on ? 1 : 0, voiceAudio.ctx.currentTime, 0.01);
}

/** Creates the playback graph. Call from a user gesture so the context is allowed to start. */
export async function startPlayback(): Promise<void> {
  if (playCtx) return;
  const ctx: SinkContext = new AudioContext({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.connect(ctx.destination);
  playCtx = ctx;
  await ctx.resume().catch(() => {});
  await applyOutputDevice();
  applyLevels();
}

async function applyOutputDevice(): Promise<void> {
  const ctx = playCtx;
  if (!ctx?.setSinkId) return;
  try {
    await ctx.setSinkId(useSettings.getState().outputDeviceId); // '' = system default
  } catch (e) {
    console.warn('output device unavailable', e);
  }
}

export function attachRemote(key: string, userId: string, track: MediaStreamTrack): void {
  if (!playCtx || !master) return;
  detachRemote(key);
  const stream = new MediaStream([track]);
  const source = playCtx.createMediaStreamSource(stream);
  const gain = playCtx.createGain();
  source.connect(gain);
  gain.connect(master);
  // Chromium can leave WebRTC tracks silent in WebAudio unless a media element also plays them.
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = stream;
  void sink.play().catch(() => {});
  remotes.set(key, { userId, source, gain, sink });
  applyLevels();
}

export function detachRemote(key: string): void {
  const r = remotes.get(key);
  if (!r) return;
  r.source.disconnect();
  r.gain.disconnect();
  r.sink.srcObject = null;
  remotes.delete(key);
}

export function setDeafened(on: boolean): void {
  deafened = on;
  applyLevels();
}

function applyLevels(): void {
  if (!playCtx || !master) return;
  const { masterVolume, userVolumes, mutedUsers } = useSettings.getState();
  const t = playCtx.currentTime;
  master.gain.setTargetAtTime(deafened ? 0 : masterVolume, t, 0.02);
  for (const r of remotes.values()) {
    r.gain.gain.setTargetAtTime(mutedUsers[r.userId] ? 0 : (userVolumes[r.userId] ?? 1), t, 0.02);
  }
}

export function closeAudio(): void {
  for (const key of [...remotes.keys()]) detachRemote(key);
  void playCtx?.close();
  playCtx = null;
  master = null;
  deafened = false;
  micSource?.disconnect();
  micSource = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void voiceAudio.ctx?.close();
  voiceAudio.ctx = null;
  voiceAudio.mixIn = null;
  micGain = null;
  micGate = null;
  micMeter = null;
  meterBuf = null;
}

// Settings changes apply live, both during a call and before one.
useSettings.subscribe((s, prev) => {
  const ctx = voiceAudio.ctx;
  if (ctx && micGain && s.micGain !== prev.micGain) micGain.gain.setTargetAtTime(s.micGain, ctx.currentTime, 0.01);
  if (s.inputDeviceId !== prev.inputDeviceId || s.noiseSuppression !== prev.noiseSuppression || s.echoCancellation !== prev.echoCancellation) {
    setInputDevice(s.inputDeviceId).catch((e) => console.warn('mic change failed', e));
  }
  if (s.outputDeviceId !== prev.outputDeviceId) void applyOutputDevice();
  if (s.masterVolume !== prev.masterVolume || s.userVolumes !== prev.userVolumes || s.mutedUsers !== prev.mutedUsers) applyLevels();
});
