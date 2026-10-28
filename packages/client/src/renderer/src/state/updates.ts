import { create } from 'zustand';
import { compareVersions, type UpdateStatus, type VersionInfo } from '@chatward/shared';
import { DEMO_URL } from '../demo';
import { useVoice } from './voice';

/** How this app build compares with the server it is pointed at. */
export type ServerVersionState =
  | { kind: 'unknown' } // not checked yet, or the server did not answer
  | { kind: 'ok' }
  | { kind: 'server-behind'; serverVersion: string; clientVersion: string }
  | { kind: 'update-required'; minClientVersion: string; clientVersion: string };

interface UpdatesState {
  clientVersion: string;
  status: UpdateStatus;
  server: ServerVersionState;
}

export const useUpdates = create<UpdatesState>(() => ({
  clientVersion: '',
  status: { state: 'idle' },
  server: { kind: 'unknown' },
}));

let ready: Promise<void> | null = null;

/** Reads the app version and subscribes to updater status from the main process. Runs once. */
export function initUpdates(): Promise<void> {
  ready ??= (async () => {
    useUpdates.setState({ clientVersion: await window.chatward.updates.getVersion() });
    window.chatward.updates.onStatus((status) => useUpdates.setState({ status }));
    useUpdates.setState({ status: await window.chatward.updates.getStatus() });
  })();
  return ready;
}

/** Restarts to apply a downloaded update. Ends any call first, so the restart does not leave a ghost voice slot behind. */
export async function installUpdate(): Promise<void> {
  await useVoice.getState().leave().catch((e) => console.warn('could not leave call before update', e));
  await window.chatward.updates.install();
}

/**
 * Asks the server for its version info. Starts the background download when the server publishes a build.
 * A server that cannot be reached leaves the state as `unknown`, so the app still opens the login screen.
 */
export async function checkServerVersion(serverUrl: string): Promise<void> {
  await initUpdates();
  if (serverUrl === DEMO_URL) { useUpdates.setState({ server: { kind: 'ok' } }); return; }
  let info: VersionInfo;
  try {
    const res = await fetch(serverUrl.replace(/\/$/, '') + '/api/version');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = (await res.json()) as VersionInfo;
  } catch {
    useUpdates.setState({ server: { kind: 'unknown' } });
    return;
  }
  const clientVersion = useUpdates.getState().clientVersion;
  if (info.latestClientVersion) {
    window.chatward.updates.check(serverUrl).catch((e: unknown) => console.warn('[updates]', e));
  }
  if (compareVersions(clientVersion, info.minClientVersion) < 0) {
    useUpdates.setState({ server: { kind: 'update-required', minClientVersion: info.minClientVersion, clientVersion } });
  } else if (compareVersions(info.serverVersion, clientVersion) < 0) {
    useUpdates.setState({ server: { kind: 'server-behind', serverVersion: info.serverVersion, clientVersion } });
  } else {
    useUpdates.setState({ server: { kind: 'ok' } });
  }
}
