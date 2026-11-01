import { extractUrls } from '../media';
import './spotify.css';

// A Spotify Jam invite link, as Spotify's "Invite" button copies it. Spotify offers no way for other apps to start or
// join a Jam, so the card just opens the invite in Spotify.
const JAM_PATH = /^\/socialsession\/[A-Za-z0-9]+$/;

export function jamLinks(text: string): string[] {
  return extractUrls(text).filter((raw) => {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'open.spotify.com' && JAM_PATH.test(url.pathname);
  });
}

/** A "Join Jam" card for each Jam invite link in a message. */
export default function JamCards({ text }: { text: string }) {
  return (
    <>
      {jamLinks(text).map((url) => (
        <div key={url} className="spotify-jam">
          <span className="spotify-jam-text">
            <span className="spotify-jam-title">🎧 Spotify Jam</span>
            <span className="spotify-jam-hint">Listen along and add songs to the queue. Needs Spotify Premium.</span>
          </span>
          <a className="spotify-jam-join" href={url} target="_blank" rel="noopener noreferrer">Join Jam</a>
        </div>
      ))}
    </>
  );
}
