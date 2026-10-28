// OWNER: voice-media thread. Called by state/voice.ts (voice-core). Contract:
import { Track, VideoPresets, createLocalVideoTrack, type LocalVideoTrack, type Room } from 'livekit-client';

export interface ScreenShareOptions {
  height: 720 | 1080;
  frameRate: 30 | 60;
  systemAudio: boolean;
}

export const DEFAULT_SCREEN_OPTIONS: ScreenShareOptions = { height: 1080, frameRate: 60, systemAudio: false };

// Chosen in ScreenPicker and read by startScreen, so setScreen(on, sourceId) keeps its contract.
let screenOptions: ScreenShareOptions = DEFAULT_SCREEN_OPTIONS;

export function setScreenShareOptions(opts: ScreenShareOptions): void {
  screenOptions = opts;
}

function screenBitrate({ height, frameRate }: ScreenShareOptions): number {
  if (height === 1080) return frameRate === 60 ? 6_000_000 : 4_000_000;
  return frameRate === 60 ? 4_000_000 : 2_500_000;
}

function cameraPublication(room: Room) {
  return room.localParticipant.getTrackPublication(Track.Source.Camera);
}

export async function startCamera(room: Room, deviceId?: string): Promise<void> {
  const preset = VideoPresets.h720;
  // A muted camera track is only unmuted by setCameraEnabled, which ignores the chosen camera, so apply it after.
  const resumed = cameraPublication(room)?.isMuted === true;
  await room.localParticipant.setCameraEnabled(true, { deviceId, resolution: preset.resolution }, { videoEncoding: preset.encoding });
  if (resumed) await applyCameraChoice(room, deviceId ?? '');
}

export async function stopCamera(room: Room): Promise<void> {
  await room.localParticipant.setCameraEnabled(false);
}

/**
 * Makes the live camera track use the chosen camera. '' means the system default, which LiveKit can't name,
 * so the old track is unpublished and a fresh one is published on the default.
 */
async function applyCameraChoice(room: Room, deviceId: string): Promise<void> {
  const track = cameraPublication(room)?.track as LocalVideoTrack | undefined;
  if (!track) return;
  if (deviceId) {
    if ((await track.getDeviceId(false)) !== deviceId) await room.switchActiveDevice('videoinput', deviceId);
    return;
  }
  const preset = VideoPresets.h720;
  await room.localParticipant.unpublishTrack(track, true);
  const fresh = await createLocalVideoTrack({ resolution: preset.resolution });
  await room.localParticipant.publishTrack(fresh, { videoEncoding: preset.encoding });
}

/** Swaps the camera of a live call. */
export async function switchCamera(room: Room, deviceId: string): Promise<void> {
  await applyCameraChoice(room, deviceId);
}

/** sourceId from window.chatward.getScreenSources(); calls selectScreenSource then publishes screen (+system audio if available) */
export async function startScreen(room: Room, sourceId: string): Promise<void> {
  const opts = screenOptions;
  // The main process reads the selected source when getDisplayMedia runs, so select it first.
  await window.chatward.selectScreenSource(sourceId);
  await room.localParticipant.setScreenShareEnabled(
    true,
    {
      audio: opts.systemAudio,
      resolution: { width: opts.height === 1080 ? 1920 : 1280, height: opts.height, frameRate: opts.frameRate },
      contentHint: opts.frameRate === 60 ? 'motion' : 'detail',
    },
    { screenShareEncoding: { maxBitrate: screenBitrate(opts), maxFramerate: opts.frameRate } },
  );
}

export async function stopScreen(room: Room): Promise<void> {
  await room.localParticipant.setScreenShareEnabled(false);
}
