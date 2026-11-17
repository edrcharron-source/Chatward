/**
 * Standard Unicode emoji only. The system font draws them (Apple's on a Mac or iPhone), so the app ships no emoji
 * image files of its own.
 */
export const SCROLL_EMOJI = ['✨', '🎲', '🔥', '🚀', '🌈', '🎉', '🍕', '🦄', '🌟', '🐸', '🥳', '🎈', '🍉', '🎯', '🪩', '🦊', '🐙', '🍩', '🌶️', '🎸', '🛸', '🍄', '🐧', '🍓', '🎨', '💫', '🥑', '🪐', '🌻', '🐝'];

/** One emoji from the list. `rnd` is injectable for tests. */
export function pickEmoji(rnd: () => number = Math.random): string {
  return SCROLL_EMOJI[Math.floor(rnd() * SCROLL_EMOJI.length) % SCROLL_EMOJI.length];
}
