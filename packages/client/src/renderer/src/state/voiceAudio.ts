// Shared WebAudio graph for the outgoing mic. voice-core populates; soundboard reads.
// mic -> micGain -> mixIn -> destination (published to LiveKit as the mic track)
export const voiceAudio: {
  ctx: AudioContext | null;
  /** connect extra sources here to send them to everyone in the call (soundboard) */
  mixIn: AudioNode | null;
} = { ctx: null, mixIn: null };
