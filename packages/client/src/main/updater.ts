import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile, rm } from 'node:fs/promises';
import type { UpdateStatus } from '@chatward/shared';
import { UPDATE_PUBLIC_KEY_PEM } from './updateKey';
import { isSignedBy } from './updateSignature';

// The app updates from the user's own server (GET <server>/updates/latest.yml), not GitHub, because the repo is private.
// The feed is set at runtime because the server address is typed in by the user at login.
// Every installer must come with a signature (<installer>.sig) made by our private key. The app checks it before install,
// so a compromised server or network can block updates but cannot push its own code.
const RECHECK_MS = 4 * 60 * 60 * 1000;
const INSTALLER_NAME = 'Chatward-Setup.exe';

let status: UpdateStatus = { state: 'idle' };
let feedBase: string | null = null;
let downloadingVersion = '';

function setStatus(next: UpdateStatus): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status', next);
}

function checkNow(): void {
  if (!feedBase) return;
  // Failures arrive through the 'error' event; the rejection is only here to keep it from going unhandled.
  autoUpdater.checkForUpdates().catch(() => undefined);
}

async function fetchSignature(): Promise<Buffer> {
  if (!feedBase) throw new Error('no update server');
  const res = await fetch(`${feedBase}/${INSTALLER_NAME}.sig`);
  if (!res.ok) throw new Error(`signature download failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Runs after the installer is downloaded. Only a verified installer reaches the 'ready' state, and only that state can install.
async function verifyDownload(version: string, installerPath: string): Promise<void> {
  try {
    const [installer, signature] = await Promise.all([readFile(installerPath), fetchSignature()]);
    if (!isSignedBy(installer, signature, UPDATE_PUBLIC_KEY_PEM)) throw new Error('signature does not match');
    setStatus({ state: 'ready', version });
  } catch (err) {
    console.warn('[updater] refused update', err);
    // Delete it so the next check downloads a fresh copy instead of reusing this one.
    await rm(installerPath, { force: true }).catch(() => undefined);
    setStatus({ state: 'error', message: 'The downloaded update could not be verified, so it was not installed. Chatward will try again later.' });
  }
}

export function setupUpdater(): void {
  // Download as soon as an update is found, but install only after the signature check. Nothing installs on quit by itself.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    downloadingVersion = info.version;
    setStatus({ state: 'downloading', version: info.version, percent: 0 });
    // Failures also fire the 'error' event, so the rejection is only caught here.
    autoUpdater.downloadUpdate()
      .then(([installerPath]) => verifyDownload(info.version, installerPath))
      .catch(() => undefined);
  });
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', version: downloadingVersion, percent: Math.round(p.percent) }));
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message);
    setStatus({ state: 'error', message: err.message });
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:get', () => status);
  ipcMain.handle('update:check', (_e, serverUrl: string) => {
    // Dev runs have no installer to update to, so answer "none" and skip the network.
    if (!app.isPackaged) { setStatus({ state: 'none' }); return; }
    const base = String(serverUrl).replace(/\/$/, '');
    // The installer is only trusted with its signature, but HTTPS still keeps the feed private and stops a network attacker from blocking updates.
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
    autoUpdater.quitAndInstall();
  });

  setInterval(checkNow, RECHECK_MS);
}
