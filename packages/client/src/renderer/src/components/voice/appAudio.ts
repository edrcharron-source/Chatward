// The sound of one shared app window, as a track the share can send. The desktop app records only that app (see
// main/appAudio.ts), so the voice chat and the rest of the computer stay out of the share.
import workletUrl from './appAudioWorklet.ts?worker&url';

export interface AppAudio {
  track: MediaStreamTrack;
  close(): void;
}

/** Why a window's sound couldn't be shared on its own, in words for the user. */
const REASONS: Record<string, string> = {
  'own-app': "Chatward's own window is shared without sound, so the voice chat isn't sent back to everyone.",
  unsupported: "This PC can't share one app's sound on its own (it needs Windows 11), so the window is shared without sound.",
  failed: "Couldn't get that app's sound, so the window is shared without sound.",
};

/** Starts the shared app's sound, or returns the reason it can't be shared. */
export async function openAppAudio(sourceId: string, onEnded: () => void): Promise<AppAudio | string> {
  const api = window.chatward.appAudio;
  if (!api) return REASONS.unsupported;
  const ctx = new AudioContext({ sampleRate: 48000 });
  const offs: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const off of offs) off();
    api.stop();
    void ctx.close();
  };
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const player = new AudioWorkletNode(ctx, 'chatward-app-audio', { numberOfInputs: 0, outputChannelCount: [2] });
    const out = ctx.createMediaStreamDestination();
    player.connect(out);
    offs.push(api.onData((bytes) => {
      // Copied so the samples line up on a 2-byte boundary and can be handed to the audio thread.
      const pcm = new Int16Array(bytes.slice().buffer);
      player.port.postMessage(pcm, [pcm.buffer]);
    }));
    offs.push(api.onEnded(() => { if (!closed) onEnded(); }));
    void ctx.resume();
    const result = await api.start(sourceId);
    if (result !== 'ok') {
      close();
      return REASONS[result] ?? REASONS.failed;
    }
    return { track: out.stream.getAudioTracks()[0], close };
  } catch {
    close();
    return REASONS.failed;
  }
}
