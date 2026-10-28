import { contextBridge, ipcRenderer } from 'electron';

const api = {
  secureStore: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secure:set', key, value),
  },
  getScreenSources: (): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]> =>
    ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id: string): Promise<void> => ipcRenderer.invoke('screen:select', id),
  // Demo mode only. `gifs` resolves to null when no KLIPY key is saved.
  demo: {
    linkPreview: (url: string): Promise<{ status: number; body: unknown }> => ipcRenderer.invoke('demo:linkpreview', url),
    gifs: (kind: 'search' | 'trending', q: string, pos?: string): Promise<{ status: number; body: unknown } | null> =>
      ipcRenderer.invoke('demo:gifs', kind, q, pos),
  },
};
contextBridge.exposeInMainWorld('chatward', api);
export type ChatwardApi = typeof api;
