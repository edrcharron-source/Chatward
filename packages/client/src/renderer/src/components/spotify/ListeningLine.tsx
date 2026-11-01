import { useSpotify } from '../../state/spotify';
import './spotify.css';

/**
 * "Listening to Song by Artist" under a member's name, while they share it. Links to the track when Spotify gave one,
 * unless `link` is false (inside a button, where a link can't go).
 */
export default function ListeningLine({ userId, link = true }: { userId: string; link?: boolean }) {
  const activity = useSpotify((s) => s.activities[userId]);
  if (!activity) return null;
  const text = `Listening to ${activity.title}${activity.artist ? ` by ${activity.artist}` : ''}`;
  return link && activity.url
    ? <a className="spotify-listening" href={activity.url} target="_blank" rel="noopener noreferrer" title={`${text} on Spotify`}>🎵 {text}</a>
    : <span className="spotify-listening" title={text}>🎵 {text}</span>;
}
