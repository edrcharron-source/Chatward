import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateStatus } from '@chatward/shared';
import type { NowPlaying, PlayResult } from '../main/spotify';

const api = {
  secureStore: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secure:set', key, value),
  },
  getScreenSources: (): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]> =>
    ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id: string): Promise<void> => ipcRenderer.invoke('screen:select', id),
  // Flashes the taskbar button until the window is focused. The main process ignores it while the window has focus.
  flashWindow: (): void => ipcRenderer.send('window:flash'),
  // The app's own title bar (no system frame). `target` names a pop-out window this page opened; leave it out for this window.
  windowControls: {
    platform: process.platform,
    minimize: (target?: string): void => ipcRenderer.send('window:control', 'minimize', target),
    toggleMaximize: (target?: string): void => ipcRenderer.send('window:control', 'maximize', target),
    close: (target?: string): void => ipcRenderer.send('window:control', 'close', target),
    isMaximized: (target?: string): Promise<boolean> => ipcRenderer.invoke('window:maximized', target),
    // True in the transparent, borderless window the LCARS layout uses (only its frame shows; see main/index.ts).
    shaped: process.argv.includes('--chatward-shaped'),
    // Says whether the layout wants that window. When it differs from this one, the window is swapped for a new one.
    setShaped: (want: boolean): void => ipcRenderer.send('window:shaped', want),
    // A shaped window has no system border, so the page's own edges resize it: start on pointer down, end on pointer up.
    startResize: (edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'): void => ipcRenderer.send('window:resize', edge),
    endResize: (): void => ipcRenderer.send('window:resize-end'),
  },
  // Auto-update. `check` points the updater at <serverUrl>/updates and starts a background download.
  updates: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:get'),
    check: (serverUrl: string): Promise<void> => ipcRenderer.invoke('update:check', serverUrl),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateStatus) => cb(s);
      ipcRenderer.on('update:status', listener);
      return () => { ipcRenderer.off('update:status', listener); };
    },
  },
  // Demo mode only. `gifs` resolves to null when no KLIPY key is saved.
  demo: {
    linkPreview: (url: string): Promise<{ status: number; body: unknown }> => ipcRenderer.invoke('demo:linkpreview', url),
    gifs: (kind: 'search' | 'trending', q: string, pos?: string): Promise<{ status: number; body: unknown } | null> =>
      ipcRenderer.invoke('demo:gifs', kind, q, pos),
  },
  // Spotify "listening to". `available` is false in a build without a Spotify app.
  spotify: {
    status: (): Promise<{ available: boolean; connected: boolean; canPlay: boolean }> => ipcRenderer.invoke('spotify:status'),
    connect: (): Promise<void> => ipcRenderer.invoke('spotify:connect'),
    disconnect: (): Promise<void> => ipcRenderer.invoke('spotify:disconnect'),
    nowPlaying: (): Promise<NowPlaying> => ipcRenderer.invoke('spotify:now-playing'),
    // The Jam behind a spotify.link short link, or null. Sender side only, like link previews.
    // Listen Along: play a track from a position on this person's Spotify, and pause it.
    play: (trackUrl: string, positionMs: number): Promise<PlayResult> => ipcRenderer.invoke('spotify:play', trackUrl, positionMs),
    pause: (): Promise<void> => ipcRenderer.invoke('spotify:pause'),
    resolveJam: (url: string): Promise<string | null> => ipcRenderer.invoke('spotify:resolve-jam', url),
  },
  // Tells the main process which server the page may connect to. Resolves true when the page must reload first.
  server: {
    allow: (url: string): Promise<boolean> => ipcRenderer.invoke('server:allow', url),
  },
};
contextBridge.exposeInMainWorld('chatward', api);
export type ChatwardApi = typeof api;
