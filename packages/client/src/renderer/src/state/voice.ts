// Voice store contract. OWNER of bodies: voice-core agent. Other agents only read state / call actions.
import { create } from 'zustand';
import type { Room } from 'livekit-client';

export interface VoiceState {
  channelId: string | null;
  serverId: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  room: Room | null;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  /** userIds currently speaking */
  speaking: string[];
  join: (serverId: string, channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** implemented in components/voice/media.ts and wired in below */
  setCamera: (on: boolean) => Promise<void>;
  setScreen: (on: boolean, sourceId?: string) => Promise<void>;
}

export const useVoice = create<VoiceState>(() => ({
  channelId: null, serverId: null, status: 'idle', error: null, room: null,
  muted: false, deafened: false, cameraOn: false, screenOn: false, speaking: [],
  join: async () => { throw new Error('voice-core not installed'); },
  leave: async () => {},
  toggleMute: () => {}, toggleDeafen: () => {},
  setCamera: async () => {}, setScreen: async () => {},
}));
