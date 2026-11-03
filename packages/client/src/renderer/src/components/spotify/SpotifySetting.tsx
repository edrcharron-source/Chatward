import { useEffect } from 'react';
import { connectSpotify, disconnectSpotify, setSpotifyShare, useSpotify } from '../../state/spotify';
import { Section, Toggle } from '../settings/controls';
import ListeningLine from './ListeningLine';
import { useSession } from '../../state/session';
import './spotify.css';

/** Settings → Privacy: connect Spotify and choose whether others see what you're listening to. */
export default function SpotifySetting() {
  const { available, connected, canPlay, share, error } = useSpotify();
  const meId = useSession((s) => s.user?.id);
  // The status can change outside the page (a sign-in finishing in the browser), so ask again when Settings opens.
  useEffect(() => {
    void window.chatward?.spotify?.status().then((s) => useSpotify.setState({ available: s.available, connected: s.connected, canPlay: s.canPlay })).catch(() => {});
  }, []);

  return (
    <Section title="Spotify">
      {!available ? (
        <p className="muted">This copy of Chatward was built without the Spotify app, so Spotify can't be connected here.</p>
      ) : (
        <>
          <div className="setting-row">
            <span className="setting-text">
              <span>{connected ? 'Spotify is connected' : 'Connect Spotify'}</span>
              <small className="muted">
                {!connected
                  ? 'Opens Spotify in your browser to sign in. Your Spotify email must be on the group\'s Spotify app list.'
                  : canPlay
                    ? 'Chatward can see the song you are playing, and start songs when you join a Listen Along. Nothing else.'
                    : 'Connected before Listen Along existed. Reconnect to let Chatward start songs when you join one.'}
              </small>
            </span>
            {connected && canPlay && <button type="button" onClick={() => void disconnectSpotify()}>Disconnect</button>}
            {connected && !canPlay && <button type="button" className="primary" onClick={() => void connectSpotify()}>Reconnect</button>}
            {!connected && <button type="button" className="primary" onClick={() => void connectSpotify()}>Connect</button>}
          </div>
          <Toggle label="Show what I'm listening to"
            hint="Everyone in the server sees the song next to your name while it plays. It isn't end-to-end encrypted: the server relays it but never saves it."
            checked={share} onChange={setSpotifyShare} />
          {connected && share && meId && <ListeningLine userId={meId} />}
          {error && <p className="error-text" role="status">{error}</p>}
        </>
      )}
    </Section>
  );
}
