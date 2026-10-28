import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { Track, type Participant } from 'livekit-client';
import type { Channel, User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';
import { DEMO_URL } from '../../demo';
import { demoVoice } from '../../demo/voice';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import ProfileTrigger from '../profile/ProfileTrigger';
import { useMemberMenu } from './MemberMenu';
import SoundboardPanel from '../soundboard/SoundboardPanel';

const NOBODY: string[] = [];

/** What a tile can show: a LiveKit track, or a local MediaStream in demo mode. */
type Feed = Track | MediaStream;

/** One tile's worth of call state, built from either a LiveKit participant or the demo call. */
interface Entry {
  id: string;
  joined: boolean;
  local: boolean;
  micOff: boolean;
  camera?: Feed;
  screen?: Feed;
}

/** A muted camera keeps its last frame on the publication, so only a live, unmuted one counts as video. */
function cameraFeed(p: Participant): Feed | undefined {
  const pub = p.getTrackPublication(Track.Source.Camera);
  return pub && !pub.isMuted ? pub.track : undefined;
}

function liveEntry(p: Participant, local: boolean): Entry {
  return {
    id: p.identity,
    joined: true,
    local,
    micOff: !p.isMicrophoneEnabled,
    camera: cameraFeed(p),
    screen: p.getTrackPublication(Track.Source.ScreenShare)?.track,
  };
}

/** One tile as data, so the grid and the theater layout can place it differently. */
interface Spec {
  key: string;
  props: TileProps;
}

/**
 * Voice channel view. With `theaterOnly` it draws just the theater stage (no header), which the app puts above a text chat.
 */
export default function VoiceChannelView({ channel, theaterOnly = false }: { channel: Channel; theaterOnly?: boolean }) {
  const inCall = useVoice((s) => s.channelId === channel.id);
  const theaterKey = useVoice((s) => s.theaterKey);
  const setTheater = useVoice((s) => s.setTheater);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const room = useVoice((s) => s.room);
  const speaking = useVoice((s) => s.speaking);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  // re-render on room changes; the participant list is read from the room below
  useVoice((s) => s.version);
  const join = useVoice((s) => s.join);
  const leave = useVoice((s) => s.leave);
  const demo = useSession((s) => s.serverUrl === DEMO_URL);
  const selfId = useSession((s) => s.user?.id);
  const occupants = useSession((s) => s.voiceOccupants[channel.id]) ?? NOBODY;
  const members = useSession((s) => s.servers.find((b) => b.server.id === channel.serverId)?.members);
  const menu = useMemberMenu();

  const users = new Map((members ?? []).map((m) => [m.user.id, m.user]));
  const feeds = demo && inCall ? demoVoice.snapshot() : null;
  const entries: Entry[] = inCall && room
    ? [liveEntry(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => liveEntry(p, false))]
    : inCall && feeds
      ? [
        { id: selfId ?? 'you', joined: true, local: true, micOff: muted || deafened, camera: feeds.camera ?? undefined, screen: feeds.screen ?? undefined },
        // demo occupants are synthesized voices: they are "in the call" but have no video
        ...occupants.filter((id) => id !== selfId).map((id) => ({ id, joined: true, local: false, micOff: false })),
      ]
      : occupants.map((id) => ({ id, joined: false, local: false, micOff: false }));

  const specs: Spec[] = entries.flatMap((e) => {
    const user = users.get(e.id);
    // your own tiles have no menu: there is nothing to mute or kick
    const onMenu = e.local ? undefined : (ev: ReactMouseEvent) => menu.openMenu(ev, { userId: e.id, channelId: channel.id, serverId: channel.serverId });
    const base = { user, joined: e.joined, local: e.local, micOff: e.micOff, speaking: speaking.includes(e.id), onMenu };
    const screenKey = `${e.id}:screen`;
    const tiles: Spec[] = [
      { key: e.id, props: { ...base, video: e.camera } },
    ];
    if (e.screen) {
      tiles.push({
        key: screenKey,
        props: { ...base, video: e.screen, screen: true, onTheater: () => setTheater(theaterKey === screenKey ? null : screenKey) },
      });
    }
    return tiles;
  });
  // a featured share that stopped drops out, and the view falls back to the grid
  const featured = specs.find((s) => s.key === theaterKey);
  const renderTile = (s: Spec, extra?: Partial<TileProps>) => <Tile {...s.props} theater={s.key === theaterKey} {...extra} />;
  // a share that stops while it is featured would leave theater mode on an empty stage, so theater mode ends with it
  // (only while this channel is the call, since another channel's view has no shares to feature)
  useEffect(() => {
    if (inCall && theaterKey !== null && !featured) setTheater(null);
  }, [inCall, theaterKey, featured, setTheater]);

  const theaterLayout = featured && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{renderTile(featured, { fill: true })}</div>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', flex: '0 0 auto' }}>
        {specs.filter((s) => s !== featured).map((s) => (
          <div key={s.key} style={{ width: 240, flex: '0 0 240px' }}>{renderTile(s)}</div>
        ))}
      </div>
    </div>
  );

  if (theaterOnly) {
    return (
      <div style={{ height: '100%', minHeight: 0, padding: 12, boxSizing: 'border-box', display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}>
          {theaterLayout || (
            <div className="muted" style={{ textAlign: 'center', paddingTop: 40 }}>
              <p>Nobody is sharing a screen right now.</p>
              <button className="icon" onClick={() => setTheater(null)}>Exit theater</button>
            </div>
          )}
        </div>
        {inCall && (
          <aside style={{ flex: '0 0 260px', minHeight: 0, overflow: 'auto', borderLeft: '1px solid var(--border)' }}>
            <SoundboardPanel serverId={channel.serverId} channelId={channel.id} />
          </aside>
        )}
        {menu.element}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <strong style={{ color: 'var(--text-strong)' }}>{channel.name}</strong>
        <span className="muted" style={{ fontSize: 12 }}>{entries.length} in call</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {inCall && status === 'connecting' && <span className="muted">Connecting…</span>}
          {inCall
            ? <button className="danger" onClick={() => void leave()}>Leave voice</button>
            : <button className="primary" onClick={() => void join(channel.serverId, channel.id)}>Join voice</button>}
        </div>
      </header>

      {inCall && status === 'error' && error && (
        <div role="alert" style={{ padding: '8px 16px', color: 'var(--danger)' }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 16 }}>
          {entries.length === 0
            ? <div className="muted" style={{ margin: 'auto', textAlign: 'center', paddingTop: 40 }}>Nobody is in this voice channel yet.</div>
            : theaterLayout || (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                {specs.map((s) => <Fragment key={s.key}>{renderTile(s)}</Fragment>)}
              </div>
            )}
        </div>
        {inCall && (
          <aside style={{ flex: '0 0 260px', minHeight: 0, overflow: 'auto', borderLeft: '1px solid var(--border)' }}>
            <SoundboardPanel serverId={channel.serverId} channelId={channel.id} />
          </aside>
        )}
      </div>
      {menu.element}
    </div>
  );
}

interface TileProps {
  user?: User;
  joined: boolean;
  local: boolean;
  micOff: boolean;
  speaking: boolean;
  screen?: boolean;
  video?: Feed;
  /** right-click on this tile opens the member menu (not set for yourself) */
  onMenu?: (e: ReactMouseEvent) => void;
  /** this share is the one shown in theater mode */
  theater?: boolean;
  /** grow to fill the space it is given instead of keeping 16:9 */
  fill?: boolean;
  /** toggles theater mode for this share */
  onTheater?: () => void;
}

function Tile({ user, joined, local, micOff, speaking, screen, video, onMenu, theater = false, fill = false, onTheater }: TileProps) {
  const name = user?.displayName ?? user?.username ?? 'Unknown';
  const frame = useRef<HTMLDivElement>(null);
  const full = useFullscreen(frame);
  const expanded = full || fill;

  return (
    <div className="card" data-speaking={speaking || undefined} onContextMenu={onMenu} style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, ...(fill ? { flex: 1, minHeight: 0, minWidth: 0 } : {}) }}>
      <div
        ref={frame}
        onDoubleClick={screen ? () => void toggleFullscreen(frame.current) : undefined}
        style={{
          position: 'relative', aspectRatio: expanded ? undefined : '16 / 9', borderRadius: full ? 0 : 8, overflow: 'hidden',
          background: 'var(--bg-0)', display: 'grid', placeItems: 'center',
          boxShadow: speaking && !expanded ? '0 0 0 2px var(--ok)' : 'none', transition: 'box-shadow .12s',
          ...(full ? { width: '100%', height: '100%' } : fill ? { flex: 1, minHeight: 0 } : {}),
        }}
      >
        {video
          ? <VideoView feed={video} mirror={local && !screen} />
          : user
            ? <ProfileTrigger user={user}><Avatar user={user} size={64} /></ProfileTrigger>
            : <Avatar user={user} size={64} />}
        <div style={{ position: 'absolute', left: 8, bottom: 6, fontSize: 12, color: '#fff', textShadow: '0 1px 2px #000' }}>
          {name}{local ? ' (you)' : ''}{screen ? ' · screen' : ''}{micOff && !screen ? ' · muted' : ''}
        </div>
        {screen && (
          <button
            className="icon"
            aria-label={full ? 'Exit fullscreen' : 'Fullscreen'}
            title={full ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={() => void toggleFullscreen(frame.current)}
            style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,.55)', color: '#fff' }}
          >
            {full ? '⤡' : '⤢'}
          </button>
        )}
        {onTheater && (
          <button
            className="icon"
            aria-label={theater ? 'Exit theater mode' : 'Theater mode'}
            aria-pressed={theater}
            title={theater ? 'Exit theater mode (Esc)' : 'Theater mode'}
            onClick={onTheater}
            style={{ position: 'absolute', top: 6, right: 40, background: 'rgba(0,0,0,.55)', color: '#fff' }}
          >
            ▭
          </button>
        )}
      </div>
      {!joined && <span className="muted" style={{ fontSize: 12 }}>Join to hear {name}</span>}
    </div>
  );
}

/** True while `ref`'s element is the one shown fullscreen. Esc leaves it too, even where the browser does not. */
function useFullscreen(ref: RefObject<HTMLElement | null>): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement !== null && document.fullscreenElement === ref.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.fullscreenElement === ref.current) void document.exitFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref]);
  return full;
}

async function toggleFullscreen(el: HTMLElement | null): Promise<void> {
  if (!el) return;
  // a refused request (no user gesture, unsupported) just leaves the tile as it is
  if (document.fullscreenElement === el) await document.exitFullscreen().catch(() => {});
  else await el.requestFullscreen().catch(() => {});
}

function VideoView({ feed, mirror }: { feed: Feed; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (feed instanceof MediaStream) {
      el.srcObject = feed;
      return () => { el.srcObject = null; };
    }
    feed.attach(el);
    return () => { feed.detach(el); };
  }, [feed]);
  // audio is played through the WebAudio graph, so the element stays silent
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      style={{ width: '100%', height: '100%', objectFit: 'contain', transform: mirror ? 'scaleX(-1)' : undefined }}
    />
  );
}

function Avatar({ user, size }: { user?: User; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const avatarUrl = user?.avatarUrl;
  useEffect(() => {
    if (!avatarUrl) { setSrc(null); return; }
    let objectUrl: string | null = null;
    let alive = true;
    fetchObjectUrl(avatarUrl)
      .then((u) => {
        if (alive) { objectUrl = u; setSrc(u); } else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarUrl]);

  const initial = (user?.displayName ?? user?.username ?? '?').charAt(0).toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, display: 'grid', placeItems: 'center', fontSize: size / 2.4, fontWeight: 600, color: 'var(--text-strong)' }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
    </div>
  );
}
