import { useEffect, useState } from 'react';
import type { User } from '@chatward/shared';
import { joinListenAlong, leaveListenAlong, listenPosition, useSpotify } from '../../state/spotify';
import { useSession } from '../../state/session';
import Avatar from '../chat/Avatar';
import './spotify.css';

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * "Invite to Listen Along on Spotify": the host's song as it plays right now, who is listening along, and Join / Leave.
 * The host is the message's author, so nobody can post an invite to someone else's listening.
 */
export default function ListenAlongCard({ host, serverId }: { host: User; serverId?: string }) {
  const activity = useSpotify((s) => s.activities[host.id]);
  const since = useSpotify((s) => s.since[host.id]);
  const activities = useSpotify((s) => s.activities);
  const alongWith = useSpotify((s) => s.alongWith);
  const alongError = useSpotify((s) => s.alongError);
  const meId = useSession((s) => s.user?.id);
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members ?? s.servers[0]?.members ?? []);
  const [now, setNow] = useState(() => Date.now());
  const playing = !!activity;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playing]);

  const joined = members.filter((m) => m.user.id !== host.id && activities[m.user.id]?.alongWith === host.id).map((m) => m.user);
  const listeners = playing ? [host, ...joined] : joined;
  const isHost = meId === host.id;
  const isJoined = alongWith === host.id;
  const pos = activity ? listenPosition(activity, since, now) : undefined;

  return (
    <div className="spotify-along">
      <div className="spotify-along-heading">Invite to Listen Along on Spotify</div>
      <div className="spotify-along-body">
        {activity?.coverUrl
          ? <img className="spotify-along-cover" src={activity.coverUrl} alt="" referrerPolicy="no-referrer" />
          : <div className="spotify-along-cover spotify-along-cover-empty" aria-hidden>🎵</div>}
        <div className="spotify-along-text">
          {activity ? (
            <>
              {activity.url
                ? <a className="spotify-along-title" href={activity.url} target="_blank" rel="noopener noreferrer">{activity.title}</a>
                : <span className="spotify-along-title">{activity.title}</span>}
              {activity.artist && <span className="spotify-along-artist">{activity.artist}</span>}
              {pos !== undefined && <span className="spotify-along-time">♫ {clock(pos)}{activity.durationMs ? ` / ${clock(activity.durationMs)}` : ''}</span>}
            </>
          ) : (
            <span className="spotify-along-title">{host.displayName} isn't playing anything right now</span>
          )}
          {listeners.length > 0 && (
            <span className="spotify-along-listeners" title={listeners.map((u) => u.displayName).join(', ')}>
              <span className="spotify-along-avatars">{listeners.slice(0, 5).map((u) => <Avatar key={u.id} user={u} size={18} />)}</span>
              {listeners.length} listening
            </span>
          )}
        </div>
      </div>
      {isHost ? (
        <button type="button" className="spotify-along-button" disabled>
          {joined.length ? `You're hosting · ${joined.length} joined` : "You're hosting"}
        </button>
      ) : isJoined ? (
        <button type="button" className="spotify-along-button joined" onClick={leaveListenAlong} title="Stop listening along">Joined · Leave</button>
      ) : (
        <button type="button" className="spotify-along-button primary" disabled={!playing} onClick={() => joinListenAlong(host.id)}>Join</button>
      )}
      {isJoined && alongError && <p className="error-text" role="status">{alongError}</p>}
    </div>
  );
}
