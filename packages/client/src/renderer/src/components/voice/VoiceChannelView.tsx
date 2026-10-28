import { useEffect, useRef, useState, type RefObject } from 'react';
import { Track, type Participant } from 'livekit-client';
import type { Channel, User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';
import { DEMO_URL } from '../../demo';
import { demoVoice } from '../../demo/voice';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';

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

function liveEntry(p: Participant, local: boolean): Entry {
  return {
    id: p.identity,
    joined: true,
    local,
    micOff: !p.isMicrophoneEnabled,
    camera: p.getTrackPublication(Track.Source.Camera)?.track,
    screen: p.getTrackPublication(Track.Source.ScreenShare)?.track,
  };
}

export default function VoiceChannelView({ channel }: { channel: Channel }) {
  const inCall = useVoice((s) => s.channelId === channel.id);
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
  const userVolumes = useSettings((s) => s.userVolumes);
  const setUserVolume = useSettings((s) => s.setUserVolume);

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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {entries.length === 0
          ? <div className="muted" style={{ margin: 'auto', textAlign: 'center', paddingTop: 40 }}>Nobody is in this voice channel yet.</div>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {entries.flatMap((e) => {
                const user = users.get(e.id);
                const base = { user, joined: e.joined, local: e.local, micOff: e.micOff, speaking: speaking.includes(e.id) };
                const tiles = [
                  <Tile key={e.id} {...base} video={e.camera} volume={userVolumes[e.id] ?? 1} onVolume={(v) => setUserVolume(e.id, v)} />,
                ];
                if (e.screen) {
                  tiles.push(<Tile key={`${e.id}:screen`} {...base} video={e.screen} screen />);
                }
                return tiles;
              })}
            </div>
          )}
      </div>
    </div>
  );
}

function Tile({ user, joined, local, micOff, speaking, screen, video, volume = 1, onVolume }: {
  user?: User;
  joined: boolean;
  local: boolean;
  micOff: boolean;
  speaking: boolean;
  screen?: boolean;
  video?: Feed;
  volume?: number;
  onVolume?: (v: number) => void;
}) {
  const name = user?.displayName ?? user?.username ?? 'Unknown';
  const pct = Math.round(volume * 100);
  const frame = useRef<HTMLDivElement>(null);
  const full = useFullscreen(frame);

  return (
    <div className="card" data-speaking={speaking || undefined} style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        ref={frame}
        onDoubleClick={screen ? () => void toggleFullscreen(frame.current) : undefined}
        style={{
          position: 'relative', aspectRatio: full ? undefined : '16 / 9', borderRadius: full ? 0 : 8, overflow: 'hidden',
          background: 'var(--bg-0)', display: 'grid', placeItems: 'center',
          boxShadow: speaking && !full ? '0 0 0 2px var(--ok)' : 'none', transition: 'box-shadow .12s',
          ...(full ? { width: '100%', height: '100%' } : {}),
        }}
      >
        {video
          ? <VideoView feed={video} mirror={local && !screen} />
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
      </div>
      {!screen && !local && joined && onVolume && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span className="muted">Volume</span>
          <input
            type="range" min={0} max={300} step={5} value={pct}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            aria-label={`${name} volume`}
            style={{ flex: 1 }}
          />
          <span style={{ width: 40, textAlign: 'right' }}>{pct}%</span>
        </label>
      )}
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
    if (!avatarUrl) return;
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
