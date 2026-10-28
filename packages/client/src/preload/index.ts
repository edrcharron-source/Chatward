import { contextBridge, ipcRenderer } from 'electron';

const api = {
  secureStore: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secure:set', key, value),
  },
  getScreenSources: (): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]> =>
    ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id: string): Promise<void> => ipcRenderer.invoke('screen:select', id),
};
contextBridge.exposeInMainWorld('chatward', api);
export type ChatwardApi = typeof api;
