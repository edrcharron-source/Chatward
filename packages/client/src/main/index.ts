import { app, BrowserWindow, ipcMain, safeStorage, desktopCapturer, session, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const storeFile = () => join(app.getPath('userData'), 'secure-store.json');
function readStore(): Record<string, string> {
  try { return existsSync(storeFile()) ? JSON.parse(readFileSync(storeFile(), 'utf8')) : {}; } catch { return {}; }
}

let pendingSourceId: string | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Chatward',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  // Never navigate away from the app; open links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost:5173') && !url.startsWith('file:')) { e.preventDefault(); } });
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  mkdirSync(app.getPath('userData'), { recursive: true });

  // Permissions: only media (mic/camera/screen) + clipboard-sanitized-write.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));

  // Screen share: renderer first calls chatward.getScreenSources(), user picks, then
  // chatward.selectScreenSource(id) and getDisplayMedia() resolves with that source.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const chosen = sources.find((s) => s.id === pendingSourceId);
    pendingSourceId = null;
    // 'loopback' captures system audio on Windows; renderer drops the track if the user unticks it.
    if (chosen) cb({ video: chosen, audio: 'loopback' });
    else cb({});
  });

  ipcMain.handle('secure:get', (_e, key: string) => {
    const v = readStore()[key];
    if (!v) return null;
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : Buffer.from(v, 'base64').toString('utf8');
  });
  ipcMain.handle('secure:set', (_e, key: string, value: string) => {
    const s = readStore();
    s[key] = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')).toString('base64');
    writeFileSync(storeFile(), JSON.stringify(s), { mode: 0o600 });
  });
  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon?.toDataURL() ?? null, isScreen: s.id.startsWith('screen:') }));
  });
  ipcMain.handle('screen:select', (_e, id: string) => { pendingSourceId = id; });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
