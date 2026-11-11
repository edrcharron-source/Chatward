import { create } from 'zustand';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  skin: string;             // id of the active skin (skins/index.ts); '' or an unknown id = no skin
  /** skins with animated art (the Lebserver black hole) draw it; off = none. Reduced motion always draws one still frame. */
  animatedBackgrounds: boolean;
  /** the welcome card above the chat was closed with Got it */
  welcomeDismissed: boolean;
  /**
   * 'tabs': tab bar, one text and one voice chat (the default). 'classic': the same views with the tabs
   * down a sidebar on the left. 'lcars': the tabs
   * layout's views inside the LCARS frame (components/lcars). 'orbit': the tabs layout in the Orbit frame
   * (components/orbit). Separate from the skin: every skin works in every layout.
   */
  layout: 'tabs' | 'classic' | 'lcars' | 'orbit';
  /** tabs layout split view: share of the width the left tab takes, 0.2..0.8 */
  splitRatio: number;
  /** tabs layout: the tab bar's order, by tab id; unknown ids are dropped and missing ones go at the end */
  tabOrder: string[];
  inputDeviceId: string;   // '' = default
  outputDeviceId: string;
  cameraDeviceId: string;
  masterVolume: number;    // 0..1 (output volume for all remote audio)
  micGain: number;         // 0..2 (our own mic input gain)
  noiseSuppression: boolean;
  echoCancellation: boolean;
  messageSounds: boolean;   // notification sound for new chat messages
  voiceJoinLeaveSounds: boolean;
  /** Silences every notification: message and ping sounds, join/leave sounds, and taskbar flashing. Chat highlights still show. */
  silenceAll: boolean;
  soundVolume: number;      // 0..1 for notification + join/leave sounds
  autoLoadEmbeds: boolean;  // YouTube/X embeds load without click
  linkPreviews: boolean;
  /** ask "Delete this message?" before deleting one; off = delete straight away */
  confirmDeleteMessages: boolean;
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
  theme: 'dark' as const, skin: 'lebserver', animatedBackgrounds: true, welcomeDismissed: false, layout: 'tabs' as Settings['layout'], splitRatio: 0.5, tabOrder: [] as string[], inputDeviceId: '', outputDeviceId: '', cameraDeviceId: '',
  masterVolume: 1, micGain: 1, noiseSuppression: true, echoCancellation: true,
  messageSounds: true, voiceJoinLeaveSounds: true, silenceAll: false, soundVolume: 0.6,
  autoLoadEmbeds: false, linkPreviews: true, confirmDeleteMessages: true, userVolumes: {} as Record<string, number>, mutedUsers: {} as Record<string, boolean>,
};
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();
// Settings saved before the tabs layout existed have no layout. Their empty skin is the old default rather than a
// choice, so they move to the new default look; a skin someone picked stays.
if (saved && typeof saved === 'object' && !('layout' in saved) && !saved.skin) delete saved.skin;

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
