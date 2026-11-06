import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile, rm } from 'node:fs/promises';
import type { UpdateStatus } from '@chatward/shared';
import { isSignedBy } from './updateSignature';

// The app updates from the user's own server (GET <server>/updates/latest.yml). The server fills that folder from the
// newest GitHub release (deploy/home/update-home.sh), so every member gets the same build the server was updated with.
// The feed is set at runtime because the server address is typed in by the user at login.
// The installer is not code-signed, so every update must come with <installer>.sig, made with our private key by the
// Release workflow. The app checks it before install: a compromised server or network can block updates, not push code.
const RECHECK_MS = 4 * 60 * 60 * 1000;
const INSTALLER_NAME = 'Chatward-Setup.exe';

let status: UpdateStatus = { state: 'idle' };
let feedBase: string | null = null;
let downloadingVersion = '';
// A download in progress or already checked; a recheck that finds the same version leaves it alone.
let pendingVersion: string | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status', next);
}

function checkNow(): void {
  if (!feedBase) return;
  // Don't restart a download, or re-check a verified one, while it is still in hand.
  if (status.state === 'downloading' || status.state === 'ready') return;
  // Failures arrive through the 'error' event; the rejection is only here to keep it from going unhandled.
  autoUpdater.checkForUpdates().catch(() => undefined);
}

async function fetchSignature(): Promise<Buffer> {
  if (!feedBase) throw new Error('no update server');
  const res = await fetch(`${feedBase}/${INSTALLER_NAME}.sig`);
  if (!res.ok) throw new Error(`signature download failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Runs after the installer is downloaded. Only a verified installer reaches 'ready', and only 'ready' can install.
async function verifyDownload(version: string, installerPath: string): Promise<void> {
  let installer: Buffer;
  let signature: Buffer;
  try {
    [installer, signature] = await Promise.all([readFile(installerPath), fetchSignature()]);
  } catch (err) {
    // Couldn't fetch the signature (server or network trouble): not proof of tampering, so just try again later.
    console.warn('[updater] could not check the update yet', err);
    pendingVersion = null;
    setStatus({ state: 'error', message: 'Could not check the update. Chatward will try again later.' });
    return;
  }
  if (isSignedBy(installer, version, signature, __CHATWARD_UPDATE_KEY__)) {
    // Now, and only now, may the installer run when the app quits (the user clicked Later).
    autoUpdater.autoInstallOnAppQuit = true;
    setStatus({ state: 'ready', version });
    return;
  }
  console.warn(`[updater] refused update ${version}: signature does not match`);
  // Delete it so it can never be installed, and a later check downloads a fresh copy instead of reusing this one.
  await rm(installerPath, { force: true }).catch(() => undefined);
  pendingVersion = null;
  setStatus({ state: 'rejected', version });
}

export function setupUpdater(): void {
  // Download as soon as an update is found, but install only after the signature check.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    if (status.state !== 'rejected') setStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    if (pendingVersion === info.version) return;
    pendingVersion = info.version;
    downloadingVersion = info.version;
    setStatus({ state: 'downloading', version: info.version, percent: 0 });
    // Failures also fire the 'error' event, so the rejection is only caught here.
    autoUpdater.downloadUpdate()
      .then(([installerPath]) => verifyDownload(info.version, installerPath))
      .catch(() => { pendingVersion = null; });
  });
  autoUpdater.on('update-not-available', () => {
    if (status.state !== 'rejected') setStatus({ state: 'none' });
  });
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', version: downloadingVersion, percent: Math.round(p.percent) }));
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message);
    if (status.state !== 'rejected') setStatus({ state: 'error', message: err.message });
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:get', () => status);
  ipcMain.handle('update:check', (_e, serverUrl: string) => {
    // Dev runs have no installer to update to, so answer "none" and skip the network.
    // A test build never updates: the server's feed holds the release, which would replace the build under test.
    if (!app.isPackaged || __CHATWARD_BUILD__.channel === 'test') { setStatus({ state: 'none' }); return; }
    const base = String(serverUrl).replace(/\/$/, '');
    // The signature decides what installs, but HTTPS still stops a network attacker from blocking or watching updates.
    // Plain HTTP is only allowed to this computer itself (local testing).
    let url: URL;
    try { url = new URL(base); } catch { throw new Error('Server address is not a valid URL'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      const message = 'Updates are only fetched over HTTPS. Put the server behind HTTPS to enable auto-update.';
      setStatus({ state: 'error', message });
      throw new Error(message);
    }
    feedBase = `${base}/updates`;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedBase });
    checkNow();
  });
  ipcMain.handle('update:install', () => {
    // Refuse anything that has not passed the signature check, even if the UI asks.
    if (status.state !== 'ready') throw new Error('No verified update is ready to install');
    // Silent install, then start the new version: one click from "Update" to the app open again.
    autoUpdater.quitAndInstall(true, true);
  });

  setInterval(checkNow, RECHECK_MS);
}
