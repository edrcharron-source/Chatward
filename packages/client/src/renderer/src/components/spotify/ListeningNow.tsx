import { useEffect, useState } from 'react';
import { joinListenAlong, leaveListenAlong, listenPosition, useSpotify } from '../../state/spotify';
import { useSession } from '../../state/session';
import './spotify.css';

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The full "listening now" block on a profile card: album cover, song, a progress bar that keeps moving while the card is
 * open, and a Listen along button. Shows nothing when the person isn't sharing a song.
 */
export default function ListeningNow({ userId }: { userId: string }) {
  const activity = useSpotify((s) => s.activities[userId]);
  const since = useSpotify((s) => s.since[userId]);
  const [now, setNow] = useState(() => Date.now());
  const sharing = !!activity;
  const isMe = useSession((s) => s.user?.id === userId);
  const joined = useSpotify((s) => s.alongWith === userId);
  const alongError = useSpotify((s) => s.alongError);
  // In the app, Listen along plays their song on your Spotify. Elsewhere it just opens the song.
  const canJoin = !!window.chatward?.spotify && !isMe && !activity?.alongWith;

  // Tick once a second while there is a song, so the bar and times move on.
  useEffect(() => {
    if (!sharing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sharing, since]);

  if (!activity) return null;
  const pos = listenPosition(activity, since, now);
  const length = activity.durationMs;
  return (
    <div className="spotify-now">
      {activity.coverUrl && <img className="spotify-now-cover" src={activity.coverUrl} alt="" referrerPolicy="no-referrer" />}
      <div className="spotify-now-heading">🎵 Listening now</div>
      <div className="spotify-now-track">{activity.title}</div>
      {activity.artist && <div className="spotify-now-artist">{activity.artist}</div>}
      {pos !== undefined && length !== undefined && (
        <div className="spotify-now-progress">
          <div className="spotify-now-bar" role="progressbar" aria-label="Song progress" aria-valuemin={0} aria-valuemax={length} aria-valuenow={Math.round(pos)}>
            <span style={{ width: `${Math.min(100, (pos / length) * 100)}%` }} />
          </div>
          <div className="spotify-now-times"><span>{clock(pos)}</span><span>{clock(length)}</span></div>
        </div>
      )}
      {canJoin && (
        <button type="button" className="spotify-now-listen" onClick={() => (joined ? leaveListenAlong() : joinListenAlong(userId))}>
          {joined ? 'Leave Listen along' : 'Listen along'}
        </button>
      )}
      {joined && alongError && <p className="error-text" role="status">{alongError}</p>}
      {!canJoin && !isMe && activity.url && (
        <a className="spotify-now-listen" href={activity.url} target="_blank" rel="noopener noreferrer" title="Open this song in Spotify">
          Listen along
        </a>
      )}
    </div>
  );
}
