import type { ReactNode } from 'react';
import { checkServerVersion, useUpdates } from '../../state/updates';
import './updates.css';

/** Full-screen gate shown instead of the app when this build is older than the server's minimum. */
export default function UpdateRequired({ serverUrl, minClientVersion }: { serverUrl: string; minClientVersion: string }) {
  const status = useUpdates((s) => s.status);
  const clientVersion = useUpdates((s) => s.clientVersion);

  let body: ReactNode;
  if (status.state === 'ready') {
    body = <button className="primary" onClick={() => void window.chatward.updates.install()}>Restart to update</button>;
  } else if (status.state === 'downloading') {
    body = <p className="muted">Downloading Chatward {status.version}… {status.percent}%</p>;
  } else {
    body = (
      <>
        <p className="muted">{status.state === 'error' ? `Could not download the update: ${status.message}` : 'Looking for the update…'}</p>
        <button onClick={() => void checkServerVersion(serverUrl)}>Check again</button>
      </>
    );
  }

  return (
    <div className="cw-update-gate">
      <div className="cw-update-card card">
        <h1>Update required</h1>
        <p>This server needs Chatward {minClientVersion} or newer. You have {clientVersion || 'an older version'}.</p>
        {body}
      </div>
    </div>
  );
}
