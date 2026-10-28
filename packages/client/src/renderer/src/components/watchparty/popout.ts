// Messages between the watch party panel and its pop-out window. The pop-out is a second window of this app that only
// hosts the YouTube embed. The panel keeps the sync logic and drives the embed through these messages, so the pop-out
// needs no login, keys or socket. Both sides check `event.source` before trusting a message.
import type { PlayerEvent } from './youtube';

const PARAM = 'watch-popout';

export type PanelToPopout =
  | { kind: 'load'; videoId: string }
  | { kind: 'command'; func: string; args: unknown[] }
  | { kind: 'close' };

export type PopoutToPanel =
  | { kind: 'hello' }
  | { kind: 'event'; event: PlayerEvent }
  | { kind: 'closed' };

export const isPopoutWindow = (): boolean => new URLSearchParams(window.location.search).has(PARAM);

/** The app's own page with the pop-out flag, so the same build opens the pop-out view. */
export function popoutUrl(): string {
  const url = new URL(window.location.href);
  url.search = `?${PARAM}=1`;
  url.hash = '';
  return url.toString();
}
