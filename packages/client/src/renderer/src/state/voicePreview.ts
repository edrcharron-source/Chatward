// Preview of a call you have not joined: its screen shares, from a hidden watch-only LiveKit session (see
// POST /api/voice/preview-token in docs/CONTRACT.md). Nobody in the call sees it, it sends nothing, and it receives only
// the smallest copy of each share at a low frame rate, with no sound.
import { useEffect, useState } from 'react';
import { Room, RoomEvent, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { api } from '../api/http';
import { onEpochChange, voiceKey } from '../crypto';
import { isDemo } from '../demo';
import { demoPreviewShare } from '../demo/previewShare';
import { IndexedKeyProvider, keyBuffer } from './voice';
import type { Feed } from '../components/voice/VoiceChannelView';

/** Frames per second asked of the server for a previewed share. The backdrop redraws at this rate too. */
export const PREVIEW_FPS = 2;
const PREVIEW_SIZE = { width: 320, height: 180 };
// Stands in for the demo's screen sharer, so the backdrop can be tried in demo mode.
const DEMO_SHARER = 'demo-blake';

/** One share in the previewed call. */
export interface PreviewShare {
  userId: string;
  feed: Feed;
}

/**
 * The screen shares in `channelId`'s call, while `channelId` is set. Set it only while you are not in that call and
 * someone is. Ends the preview session when it changes or the caller unmounts.
 */
export function useCallPreview(channelId: string | null, occupants: string[]): PreviewShare[] {
  const [shares, setShares] = useState<PreviewShare[]>([]);
  const demoSharer = isDemo() && channelId && occupants.includes(DEMO_SHARER);

  useEffect(() => {
    if (!channelId || isDemo()) return;
    let alive = true;
    let room: Room | null = null;
    let worker: Worker | null = null;
    let stopRekey: (() => void) | null = null;

    const update = () => {
      if (!alive || !room) return;
      const next: PreviewShare[] = [];
      for (const p of room.remoteParticipants.values()) {
        const track = p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
        if (track) next.push({ userId: p.identity, feed: track });
      }
      setShares(next);
    };
    // Only screen shares, at the smallest size and a low frame rate. Microphones, cameras and share sound stay unsubscribed.
    const want = (pub: RemoteTrackPublication) => {
      if (pub.source !== Track.Source.ScreenShare) return;
      pub.setSubscribed(true);
      pub.setVideoQuality(VideoQuality.LOW);
      pub.setVideoDimensions(PREVIEW_SIZE);
      pub.setVideoFPS(PREVIEW_FPS);
    };

    void (async () => {
      try {
        // Fail closed, as a join does: no key, no preview.
        const voice = await voiceKey(channelId);
        if (!alive || !voice) return;
        const { url, token } = await api.post<{ url: string; token: string }>('/api/voice/preview-token', { channelId });
        if (!alive) return;
        const keyProvider = new IndexedKeyProvider();
        await keyProvider.setIndexedKey(keyBuffer(voice.key), voice.epoch);
        if (!alive) return;
        worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
        room = new Room({ adaptiveStream: false, dynacast: false, e2ee: { keyProvider, worker } });
        room
          .on(RoomEvent.TrackPublished, want)
          .on(RoomEvent.TrackSubscribed, update)
          .on(RoomEvent.TrackUnsubscribed, update)
          .on(RoomEvent.TrackUnpublished, update)
          .on(RoomEvent.ParticipantDisconnected, update);
        await room.connect(url, token, { autoSubscribe: false });
        if (!alive) return;
        await room.setE2EEEnabled(true);
        if (!alive) return;
        // The call's key moves on with the channel's MLS epoch; follow it, as a joined call does.
        stopRekey = onEpochChange(() => {
          void voiceKey(channelId).then((k) => (k && alive ? keyProvider.setIndexedKey(keyBuffer(k.key), k.epoch) : undefined))
            .catch((e) => console.warn('[voice preview] rekey failed', e));
        });
        for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) want(pub);
        update();
      } catch (e) {
        // An older server has no preview endpoint, and a removed user is refused. Either way the view just has no backdrop.
        if (alive) console.warn('[voice preview] not available', e);
      }
    })();

    return () => {
      alive = false;
      stopRekey?.();
      const r = room;
      void r?.disconnect().finally(() => worker?.terminate());
      if (!r) worker?.terminate();
      setShares([]);
    };
  }, [channelId]);

  if (demoSharer) return [{ userId: DEMO_SHARER, feed: demoPreviewShare() }];
  return shares;
}
