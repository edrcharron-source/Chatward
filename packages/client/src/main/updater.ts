import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@chatward/shared';

// The app updates from the user's own server (GET <server>/updates/latest.yml), not GitHub, because the repo is private.
// The feed is set at runtime because the server address is typed in by the user at login.
const RECHECK_MS = 4 * 60 * 60 * 1000;

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

export function setupUpdater(): void {
  // Download in the background; the user chooses when to restart (or the app installs on its next quit).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    downloadingVersion = info.version;
    setStatus({ state: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', version: downloadingVersion, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }));
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
    if (!/^https?:\/\//.test(base)) throw new Error('Server address must start with http:// or https://');
    feedBase = `${base}/updates`;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedBase });
    checkNow();
  });
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  setInterval(checkNow, RECHECK_MS);
}
