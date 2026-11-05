import { Track } from 'livekit-client';
import { DEMO_URL } from '../../demo';
import { demoVoice } from '../../demo/voice';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import type { Feed } from './VoiceChannelView';

export interface ScreenShare {
  /** the screen share's picture, as the voice tiles get it */
  feed: Feed;
  /** whose screen it is, as shown on the tile */
  name: string;
}

/**
 * The screen share to show as a corner preview while the Voice tab is not on screen: the one featured in theater mode if
 * there is one, otherwise someone else's share, otherwise your own. Null when you are not in this voice chat or nobody is
 * sharing. Reads the same call state as VoiceChannelView, so both show the same share.
 */
export function useScreenShare(serverId: string | undefined, channelId: string | undefined): ScreenShare | null {
  const inCall = useVoice((s) => s.channelId === channelId);
  const room = useVoice((s) => s.room);
  const theaterKey = useVoice((s) => s.theaterKey);
  // re-render on room changes; the shares are read from the room below
  useVoice((s) => s.version);
  const demo = useSession((s) => s.serverUrl === DEMO_URL);
  const selfId = useSession((s) => s.user?.id);
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members);

  if (!inCall) return null;
  const shares: { id: string; key: string; feed: Feed }[] = [];
  if (room) {
    for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
      const track = p.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (track) shares.push({ id: p.identity, key: `${p.identity}:screen`, feed: track });
    }
  } else if (demo) {
    const screen = demoVoice.snapshot().screen;
    if (screen) shares.push({ id: selfId ?? 'you', key: `${selfId ?? 'you'}:screen`, feed: screen });
  }
  const pick = shares.find((s) => s.key === theaterKey) ?? shares.find((s) => s.id !== selfId) ?? shares[0];
  if (!pick) return null;
  const user = members?.find((m) => m.user.id === pick.id)?.user;
  return { feed: pick.feed, name: user?.displayName ?? user?.username ?? 'Unknown' };
}
