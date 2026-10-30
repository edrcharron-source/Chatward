// Every icon name the app can draw. Each skin's icon set covers all of them (see PixelIcon.tsx).
export const ICON_NAMES = [
  'text', 'voice', 'mic', 'micoff', 'deafen', 'share', 'camera', 'leave', 'watch', 'movies', 'vault', 'gear', 'plus',
  'attach', 'gif', 'emoji', 'send', 'edit', 'trash', 'sounds', 'fullscreen', 'theater', 'popout', 'user', 'shield', 'bell',
  'eye', 'palette', 'crown', 'test', 'lock', 'play', 'stop', 'upload', 'close', 'deafenoff', 'cameraoff', 'shareoff',
  'loopback', 'dot',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** A vector icon as SVG markup: `body` is drawn with `cut` punched out of it, then `over` is drawn on top. */
export interface VectorIcon {
  body: string;
  cut?: string;
  over?: string;
}
