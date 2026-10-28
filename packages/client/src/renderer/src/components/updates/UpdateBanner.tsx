import { useState } from 'react';
import { useUpdates } from '../../state/updates';
import './updates.css';

/** Thin strip at the top of the window: update progress, "restart to update", and an older-server warning. */
export default function UpdateBanner() {
  const status = useUpdates((s) => s.status);
  const server = useUpdates((s) => s.server);
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (status.state === 'downloading') {
    return <div className="cw-update-bar" role="status">Downloading Chatward {status.version}… {status.percent}%</div>;
  }
  if (status.state === 'ready' && dismissed !== status.version) {
    return (
      <div className="cw-update-bar" role="status">
        <span>Chatward {status.version} is ready.</span>
        <button className="primary" onClick={() => void window.chatward.updates.install()}>Restart to update</button>
        <button onClick={() => setDismissed(status.version)}>Later</button>
      </div>
    );
  }
  if (server.kind === 'server-behind') {
    return (
      <div className="cw-update-bar cw-update-warn" role="status">
        This server runs Chatward {server.serverVersion}, older than this app ({server.clientVersion}). Ask the server owner to update it.
      </div>
    );
  }
  return null;
}
