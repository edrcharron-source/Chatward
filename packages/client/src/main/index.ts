import { app, BrowserWindow, ipcMain, safeStorage, desktopCapturer, session, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { fetchLinkPreview } from './linkPreview';
import { searchGifs } from './klipy';
import { setupUpdater } from './updater';

const KLIPY_KEY_STORE = 'klipyApiKey';

const storeFile = () => join(app.getPath('userData'), 'secure-store.json');
const storeBackupFile = () => `${storeFile()}.bak`;

// Returns the parsed store, or null if the file is missing or unreadable (e.g. cut off by a crash mid-write).
function readStoreFile(path: string): Record<string, string> | null {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}
function readStore(): Record<string, string> {
  return readStoreFile(storeFile()) ?? readStoreFile(storeBackupFile()) ?? {};
}

// Write to a temp file first and rename it over the real one, so a crash can never leave a half-written store.
// The last good store is copied to a .bak file first, so it can be recovered if the main file is ever damaged.
function writeStore(s: Record<string, string>) {
  const file = storeFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  if (readStoreFile(file)) copyFileSync(file, storeBackupFile());
  renameSync(tmp, file);
}

const readSecret = (key: string): string | null => {
  const v = readStore()[key];
  if (!v) return null;
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : Buffer.from(v, 'base64').toString('utf8');
};

let pendingSourceId: string | null = null;

// YouTube answers embeds that arrive without a Referer with error 153. The renderer is a file:// page, which sends none,
// so give the YouTube embed requests a Referer that names the app.
const APP_REFERRER = 'https://app.chatward.local/';
function sendReferrerForYouTube() {
  const urls = ['https://www.youtube-nocookie.com/*', 'https://*.youtube-nocookie.com/*', 'https://www.youtube.com/*', 'https://*.youtube.com/*', 'https://youtube.com/*'];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Referer: APP_REFERRER } });
  });
}

// Never navigate away from the app; open links in the OS browser.
function guardWebContents(wc: Electron.WebContents) {
  wc.setWindowOpenHandler(({ url }) => {
    // Watch party pop-out: our own page with ?watch-popout=1. Everything else stays denied.
    if (url.includes('watch-popout=1') && (url.startsWith('file:') || url.startsWith('http://localhost:5173'))) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 540, resizable: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost:5173') && !url.startsWith('file:')) { e.preventDefault(); } });
}

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
  guardWebContents(win.webContents);
  // Once the user looks at the window, the taskbar flash has done its job, so stop it.
  win.on('focus', () => win.flashFrame(false));
  // Child windows (the watch-party pop-out) don't inherit the handlers above, so guard them too.
  win.webContents.on('did-create-window', (child) => guardWebContents(child.webContents));
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

  sendReferrerForYouTube();
  setupUpdater();

  ipcMain.handle('secure:get', (_e, key: string) => readSecret(key));
  // Demo-only internet access. Both run here so the renderer's CSP and CORS never apply.
  ipcMain.handle('demo:linkpreview', (_e, url: string) => fetchLinkPreview(String(url)));
  ipcMain.handle('demo:gifs', (_e, kind: 'search' | 'trending', q: string, pos?: string) =>
    searchGifs(readSecret(KLIPY_KEY_STORE)?.trim() || null, kind === 'search' ? 'search' : 'trending', String(q ?? ''), pos));
  ipcMain.handle('secure:set', (_e, key: string, value: string) => {
    const s = readStore();
    s[key] = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')).toString('base64');
    writeStore(s);
  });
  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon?.toDataURL() ?? null, isScreen: s.id.startsWith('screen:') }));
  });
  ipcMain.handle('screen:select', (_e, id: string) => { pendingSourceId = id; });
  // The renderer asks for a taskbar flash only for messages the user should see. Skip it if they are already looking.
  ipcMain.on('window:flash', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
