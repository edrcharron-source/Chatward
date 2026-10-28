import type { SoundboardSound } from '@chatward/shared';
import { api } from '../../api/http';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { voiceAudio } from '../../state/voiceAudio';

let localCtx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();

// Prefer the call's context so the clip can reach the mic mix; otherwise use our own.
function audioCtx(): AudioContext {
  if (voiceAudio.ctx) return voiceAudio.ctx;
  localCtx ??= new AudioContext();
  return localCtx;
}

function loadBuffer(sound: SoundboardSound): Promise<AudioBuffer> {
  let p = buffers.get(sound.id);
  if (!p) {
    p = api.getBytes(`/api/sounds/${sound.id}/file`).then((bytes) => audioCtx().decodeAudioData(bytes));
    p.catch(() => buffers.delete(sound.id));
    buffers.set(sound.id, p);
  }
  return p;
}

export function forgetSound(soundId: string) {
  buffers.delete(soundId);
}

/**
 * Plays a clip into the call (so everyone hears it through our mic track) and,
 * unless deafened, through our own speakers as a local monitor.
 */
export async function playSound(sound: SoundboardSound, channelId: string): Promise<void> {
  const ctx = audioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = await loadBuffer(sound);

  const { channelId: inChannel, deafened } = useVoice.getState();
  const inThisCall = inChannel === channelId && voiceAudio.mixIn !== null;

  const gain = ctx.createGain();
  gain.gain.value = useSettings.getState().soundVolume;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  if (inThisCall) gain.connect(voiceAudio.mixIn!);
  if (!deafened) gain.connect(ctx.destination);

  src.onended = () => {
    src.disconnect();
    gain.disconnect();
  };
  src.start();
}
