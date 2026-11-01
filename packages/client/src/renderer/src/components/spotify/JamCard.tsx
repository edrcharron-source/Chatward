import type { MessagePayload } from '@chatward/shared';
import { extractUrls } from '../media';
import './spotify.css';

// A Spotify Jam invite link, as Spotify's "Invite" button copies it. Spotify offers no way for other apps to start or
// join a Jam, so the card just opens the invite in Spotify.
const JAM_PATH = /^\/socialsession\/[A-Za-z0-9]+$/;

const isJamUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'open.spotify.com' && JAM_PATH.test(url.pathname);
  } catch {
    return false;
  }
};
const isShortLink = (raw: string): boolean => /^https:\/\/spotify(\.app)?\.link\//.test(raw);

/** Sender side: the Jams behind Spotify short links (spotify.link/...), which is what Spotify's Invite button copies. */
export async function resolveSpotifyJams(urls: string[]): Promise<NonNullable<MessagePayload['spotifyJams']>> {
  const resolve = window.chatward?.spotify?.resolveJam;
  if (!resolve) return [];
  const found = await Promise.all(urls.filter(isShortLink).map(async (link) => ({ link, url: await resolve(link).catch(() => null) })));
  return found.filter((j): j is { link: string; url: string } => !!j.url && isJamUrl(j.url));
}

/** The Jams in a message: direct socialsession links in the text, plus short links the sender's app resolved. */
export function jamLinks(payload: Pick<MessagePayload, 'text' | 'spotifyJams'>): { link: string; url: string }[] {
  const direct = extractUrls(payload.text).filter(isJamUrl).map((url) => ({ link: url, url }));
  // Any member can put anything in a payload, so a resolved Jam is checked again before it is drawn.
  const resolved = (payload.spotifyJams ?? []).filter((j) => typeof j?.link === 'string' && typeof j.url === 'string' && isJamUrl(j.url));
  const seen = new Set<string>();
  return [...direct, ...resolved].filter((j) => !seen.has(j.url) && seen.add(j.url));
}

/** A "Join Jam" card for each Jam invite in a message. */
export default function JamCards({ payload }: { payload: Pick<MessagePayload, 'text' | 'spotifyJams'> }) {
  return (
    <>
      {jamLinks(payload).map(({ url }) => (
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
