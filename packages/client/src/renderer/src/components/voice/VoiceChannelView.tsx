import { useEffect, useRef, useState } from 'react';
import { Track, type Participant } from 'livekit-client';
import type { Channel, User } from '@chatward/shared';
import { fetchObjectUrl } from '../../api/http';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';

const NOBODY: string[] = [];

export default function VoiceChannelView({ channel }: { channel: Channel }) {
  const inCall = useVoice((s) => s.channelId === channel.id);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const room = useVoice((s) => s.room);
  const speaking = useVoice((s) => s.speaking);
  // re-render on room changes; the participant list is read from the room below
  useVoice((s) => s.version);
  const join = useVoice((s) => s.join);
  const leave = useVoice((s) => s.leave);
  const occupants = useSession((s) => s.voiceOccupants[channel.id]) ?? NOBODY;
  const members = useSession((s) => s.servers.find((b) => b.server.id === channel.serverId)?.members);
  const userVolumes = useSettings((s) => s.userVolumes);
  const setUserVolume = useSettings((s) => s.setUserVolume);

  const users = new Map((members ?? []).map((m) => [m.user.id, m.user]));
  const entries: { id: string; participant: Participant | null }[] = inCall && room
    ? [room.localParticipant, ...room.remoteParticipants.values()].map((p) => ({ id: p.identity, participant: p }))
    : occupants.map((id) => ({ id, participant: null }));
  const isLocal = (id: string) => inCall && room?.localParticipant.identity === id;

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
              {entries.flatMap(({ id, participant }) => {
                const user = users.get(id);
                const local = isLocal(id);
                const base = { id, user, participant, local, speaking: speaking.includes(id) };
                const tiles = [<Tile key={id} {...base} volume={userVolumes[id] ?? 1} onVolume={(v) => setUserVolume(id, v)} />];
                if (participant?.getTrackPublication(Track.Source.ScreenShare)?.track) {
                  tiles.push(<Tile key={`${id}:screen`} {...base} screen />);
                }
                return tiles;
              })}
            </div>
          )}
      </div>
    </div>
  );
}

function Tile({ id, user, participant, local, speaking, screen, volume = 1, onVolume }: {
  id: string;
  user?: User;
  participant: Participant | null;
  local: boolean;
  speaking: boolean;
  screen?: boolean;
  volume?: number;
  onVolume?: (v: number) => void;
}) {
  const name = user?.displayName ?? user?.username ?? 'Unknown';
  const camera = participant?.getTrackPublication(Track.Source.Camera)?.track;
  const shared = participant?.getTrackPublication(Track.Source.ScreenShare)?.track;
  const micOff = participant ? !participant.isMicrophoneEnabled : false;
  const video = screen ? shared : camera;
  const pct = Math.round(volume * 100);

  return (
    <div className="card" data-speaking={speaking || undefined} style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        position: 'relative', aspectRatio: '16 / 9', borderRadius: 8, overflow: 'hidden',
        background: 'var(--bg-0)', display: 'grid', placeItems: 'center',
        boxShadow: speaking ? '0 0 0 2px var(--ok)' : 'none', transition: 'box-shadow .12s',
      }}>
        {video
          ? <VideoView track={video} mirror={local && !screen} />
          : <Avatar user={user} size={64} />}
        <div style={{ position: 'absolute', left: 8, bottom: 6, fontSize: 12, color: '#fff', textShadow: '0 1px 2px #000' }}>
          {name}{local ? ' (you)' : ''}{screen ? ' · screen' : ''}{micOff && !screen ? ' · muted' : ''}
        </div>
      </div>
      {!screen && !local && participant && onVolume && (
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
      {!participant && <span className="muted" style={{ fontSize: 12 }}>Join to hear {name}</span>}
    </div>
  );
}

function VideoView({ track, mirror }: { track: Track; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
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
