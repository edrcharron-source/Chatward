// The Orbit skin's icons: thin 1.5px lines, square ends and sharp corners on a 24 x 24 grid, with diamonds and
// hexagons where other sets use circles, to match the skin's line-art look. Strokes take the current text colour (see
// icons.css). `cut` and `over` work as in solidIcons.ts: the slash on the "off" icons is cut out of the icon first.
import type { IconName, VectorIcon } from './iconTypes';

const slash = (body: string): VectorIcon => ({
  body,
  cut: '<path fill="none" stroke="#000" d="M3 3l18 18" style="stroke-width:4.5"/>',
  over: '<path d="M3 3l18 18"/>',
});

const MIC = '<path d="M9 4h6v9H9zM6 11v2l6 5 6-5v-2M12 18v3"/>';
const HEADPHONES = '<path d="M4 15v-5l8-6 8 6v5M3 15h5v6H3zM16 15h5v6h-5z"/>';
const SCREEN = '<path d="M3 5h18v12H3zM8 20h8M12 17v3"/>';
const CAMERA = '<path d="M3 7h12v10H3zM15 11l6-3v8l-6-3"/>';

export const GLYPH: Record<IconName, VectorIcon> = {
  text: { body: '<path d="M4 5h16v11h-9l-4 3v-3H4z"/>' },
  voice: { body: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>' },
  mic: { body: MIC },
  micoff: slash(MIC),
  deafen: { body: HEADPHONES },
  deafenoff: slash(HEADPHONES),
  share: { body: `${SCREEN}<path d="M12 14V8M9 11l3-3 3 3"/>` },
  shareoff: slash(SCREEN),
  camera: { body: CAMERA },
  cameraoff: slash(CAMERA),
  leave: { body: '<path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10"/>' },
  watch: { body: '<path d="M3 5h18v13H3zM10 9l5 3-5 3z"/>' },
  movies: { body: '<path d="M3 6h18v14H3zM3 10h18M7 6l2 4M12 6l2 4M17 6l2 4"/>' },
  vault: { body: '<path d="M12 2l9 5v10l-9 5-9-5V7zM10 9h4v3l-2 3-2-3z"/>' },
  gear: { body: '<path d="M12 2l8.5 5v10L12 22l-8.5-5V7zM12 9l3 3-3 3-3-3z"/>' },
  plus: { body: '<path d="M12 5v14M5 12h14"/>' },
  attach: { body: '<path d="M16 7l-8 8a2.5 2.5 0 0 0 3.5 3.5l8-8a4 4 0 0 0-5.6-5.6l-8 8"/>' },
  gif: { body: '<path d="M3 6h18v12H3zM9 10H6v4h3v-2M12 10v4M15 14v-4h3M15 12h2"/>' },
  emoji: { body: '<path d="M12 3l9 9-9 9-9-9zM9 11h.5M15 11h-.5M9 14l3 2 3-2"/>' },
  send: { body: '<path d="M3 11L21 4l-7 17-3-7zM11 14L21 4"/>' },
  edit: { body: '<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>' },
  trash: { body: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15"/>' },
  sounds: { body: '<path d="M3 9h4l5-4v14l-5-4H3zM16 9l2 3-2 3M19 6l3 6-3 6"/>' },
  fullscreen: { body: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>' },
  theater: { body: '<path d="M3 5h18v14H3zM12 5v14"/>' },
  popout: { body: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>' },
  user: { body: '<path d="M12 3l4 4-4 4-4-4zM5 21l2-7h10l2 7"/>' },
  shield: { body: '<path d="M12 2l8 3v7l-8 10-8-10V5z"/>' },
  bell: { body: '<path d="M6 17v-7l6-6 6 6v7M4 17h16M10 20h4"/>' },
  eye: { body: '<path d="M2 12l10-6 10 6-10 6zM12 10l2 2-2 2-2-2z"/>' },
  palette: { body: '<path d="M12 3l9 16H3zM12 10v.5M9 15v.5M15 15v.5"/>' },
  crown: { body: '<path d="M3 19h18M3 16V8l5 4 4-7 4 7 5-4v8z"/>' },
  test: { body: '<path d="M9 3h6M10 3v6L4 20h16L14 9V3M7 15h10"/>' },
  lock: { body: '<path d="M5 11h14v10H5zM8 11V7l4-4 4 4v4"/>' },
  play: { body: '<path d="M7 4l13 8-13 8z"/>' },
  stop: { body: '<path d="M6 6h12v12H6z"/>' },
  upload: { body: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>' },
  close: { body: '<path d="M5 5l14 14M19 5L5 19"/>' },
  loopback: { body: '<path d="M4 12V7h13M14 4l3 3-3 3M20 12v5H7M10 20l-3-3 3-3"/>' },
  dot: { body: '<path d="M12 7l5 5-5 5-5-5z" fill="currentColor"/>' },
  search: { body: '<path d="M10 3l7 7-7 7-7-7zM15 15l6 6"/>' },
};
