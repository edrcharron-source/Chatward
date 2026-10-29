import { create } from 'zustand';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  skin: string;             // id of the active skin (skins/index.ts); '' or an unknown id = no skin
  /** 'tabs': tab bar, one text and one voice chat (the default). 'classic': the channel sidebar layout. */
  layout: 'tabs' | 'classic';
  /** tabs layout split view: share of the width the text chat takes, 0.2..0.8 */
  splitRatio: number;
  inputDeviceId: string;   // '' = default
  outputDeviceId: string;
  cameraDeviceId: string;
  masterVolume: number;    // 0..1 (output volume for all remote audio)
  micGain: number;         // 0..2 (our own mic input gain)
  noiseSuppression: boolean;
  echoCancellation: boolean;
  messageSounds: boolean;   // notification sound for new chat messages
  mutedChannels: string[];  // channelIds with silenced notification sound
  voiceJoinLeaveSounds: boolean;
  soundVolume: number;      // 0..1 for notification + join/leave sounds
  autoLoadEmbeds: boolean;  // YouTube/X embeds load without click
  linkPreviews: boolean;
  /** per remote user volume 0..3 (1 = 100%, up to 300% boost); keyed by userId */
  userVolumes: Record<string, number>;
  /** people you have muted for yourself only; keyed by userId */
  mutedUsers: Record<string, boolean>;
  set: (patch: Partial<Omit<Settings, 'set' | 'setUserVolume' | 'setUserMuted'>>) => void;
  setUserVolume: (userId: string, v: number) => void;
  setUserMuted: (userId: string, muted: boolean) => void;
}

const LS = 'chatward.settings';
const defaults = {
  theme: 'dark' as const, skin: '', layout: 'tabs' as 'tabs' | 'classic', splitRatio: 0.5, inputDeviceId: '', outputDeviceId: '', cameraDeviceId: '',
  masterVolume: 1, micGain: 1, noiseSuppression: true, echoCancellation: true,
  messageSounds: true, mutedChannels: [] as string[], voiceJoinLeaveSounds: true, soundVolume: 0.6,
  autoLoadEmbeds: false, linkPreviews: true, userVolumes: {} as Record<string, number>, mutedUsers: {} as Record<string, boolean>,
};
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();

export const useSettings = create<Settings>((set, get) => ({
  ...defaults, ...saved,
  set: (patch) => { set(patch); persist(get()); },
  setUserVolume: (userId, v) => { set({ userVolumes: { ...get().userVolumes, [userId]: v } }); persist(get()); },
  setUserMuted: (userId, muted) => { set({ mutedUsers: { ...get().mutedUsers, [userId]: muted } }); persist(get()); },
}));

function persist(s: Settings) {
  const { set: _s, setUserVolume: _u, setUserMuted: _m, ...data } = s;
  localStorage.setItem(LS, JSON.stringify(data));
}

export function applyTheme(t: Settings['theme']) {
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = eff;
}
