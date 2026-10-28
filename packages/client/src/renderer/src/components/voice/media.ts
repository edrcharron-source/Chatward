// OWNER: voice-media thread. Called by state/voice.ts (voice-core). Contract:
import type { Room } from 'livekit-client';
export async function startCamera(_room: Room, _deviceId?: string): Promise<void> {}
export async function stopCamera(_room: Room): Promise<void> {}
/** sourceId from window.chatward.getScreenSources(); calls selectScreenSource then publishes screen (+system audio if available) */
export async function startScreen(_room: Room, _sourceId: string): Promise<void> {}
export async function stopScreen(_room: Room): Promise<void> {}
