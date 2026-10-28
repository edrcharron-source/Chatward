import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateStatus } from '@chatward/shared';

const api = {
  secureStore: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secure:set', key, value),
  },
  getScreenSources: (): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]> =>
    ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id: string): Promise<void> => ipcRenderer.invoke('screen:select', id),
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
};
contextBridge.exposeInMainWorld('chatward', api);
export type ChatwardApi = typeof api;
