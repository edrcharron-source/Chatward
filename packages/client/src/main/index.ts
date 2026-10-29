import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, desktopCapturer, screen, session, shell } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { fetchLinkPreview } from './linkPreview';
import { searchGifs } from './klipy';
import { setupUpdater } from './updater';
import { APP_ORIGIN, buildCsp, loadServerOrigin, saveServerOrigin, serverOrigin } from './serverPolicy';
import { fitWindow } from './windowBounds';

// The page is served from app:// (not file://) so its Content-Security-Policy header can name the server.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, corsEnabled: true } }]);

// A test build installs next to the real app as "Chatward Test" but shares its userData folder. Keys in secure-store.json
// are encrypted with a key kept in that folder's Local State, so a separate folder can't read the real app's keys and
// every channel stays locked. This runs before anything reads userData.
if (__CHATWARD_BUILD__.channel === 'test') {
  app.setName('Chatward Test');
  app.setPath('userData', join(app.getPath('appData'), 'Chatward'));
}

const KLIPY_KEY_STORE = 'klipyApiKey';
const rendererDir = join(__dirname, '../renderer');
// The server the page may connect to. Set by the renderer when the user connects to a server.
let allowedServer: string | null = null;

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

// True for the app's own page (and the dev server while developing). Embedded third-party frames are not.
function isAppPage(url: string | undefined): boolean {
  if (!url) return false;
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return url.startsWith(APP_ORIGIN + '/') || (!!dev && url.startsWith(dev));
}

// Never navigate away from the app; open links in the OS browser.
function guardWebContents(wc: Electron.WebContents) {
  wc.setWindowOpenHandler(({ url, frameName }) => {
    // A popped-out tab: an empty window the app draws into itself (components/tabs/PopoutWindow.tsx). It loads nothing.
    if (url === 'about:blank' && frameName.startsWith('chatward-tab-')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 700, minWidth: 420, minHeight: 320, resizable: true, autoHideMenuBar: true, titleBarStyle: 'hidden', backgroundColor: '#1e1f22', title: 'Chatward', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } } };
    }
    // Watch party pop-out: our own page with ?watch-popout=1. Everything else stays denied.
    if (url.includes('watch-popout=1') && (url.startsWith(APP_ORIGIN + '/') || url.startsWith('http://localhost:5173'))) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 540, resizable: true, autoHideMenuBar: true, titleBarStyle: 'hidden', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost:5173') && !url.startsWith(APP_ORIGIN + '/')) { e.preventDefault(); } });
}

// Pop-out windows by the name the page opened them with, per opening page. A popped-out tab runs no code of its own,
// so the main window's page works its title bar buttons and names the window it means (components/titlebar).
const childWindows = new WeakMap<Electron.WebContents, Map<string, BrowserWindow>>();
// Every window's page that belongs to the app: the main window and the pop-outs it opened (a popped-out tab is
// about:blank, so its own address doesn't say it is ours).
const appWindowContents = new WeakSet<Electron.WebContents>();

function controlledWindow(sender: Electron.WebContents, target: unknown): BrowserWindow | null {
  if (typeof target === 'string' && target) {
    const child = childWindows.get(sender)?.get(target);
    return child && !child.isDestroyed() ? child : null;
  }
  return BrowserWindow.fromWebContents(sender);
}

function createWindow() {
  // Fit to the primary display's work area so the bottom edge is not hidden behind the taskbar on small or scaled screens.
  const bounds = fitWindow(screen.getPrimaryDisplay().workArea, { width: 1280, height: 800, minWidth: 900, minHeight: 600 });
  const win = new BrowserWindow({
    ...bounds,
    backgroundColor: '#1e1f22',
    title: 'Chatward',
    autoHideMenuBar: true,
    // No system frame: the page draws its own title bar (components/titlebar). 'hidden' keeps the edge resizing,
    // the shadow and Windows snap that frame: false would lose. macOS keeps its traffic lights.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  guardWebContents(win.webContents);
  appWindowContents.add(win.webContents);
  // Once the user looks at the window, the taskbar flash has done its job, so stop it.
  win.on('focus', () => win.flashFrame(false));
  // Child windows (the watch-party pop-out) don't inherit the handlers above, so guard them too.
  // They live on this window's page, so they close with it.
  win.webContents.on('did-create-window', (child, { frameName }) => {
    guardWebContents(child.webContents);
    appWindowContents.add(child.webContents);
    if (frameName) {
      const named = childWindows.get(win.webContents) ?? new Map<string, BrowserWindow>();
      childWindows.set(win.webContents, named);
      named.set(frameName, child);
      child.on('closed', () => { if (named.get(frameName) === child) named.delete(frameName); });
    }
    win.on('closed', () => { if (!child.isDestroyed()) child.close(); });
  });
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else win.loadURL(`${APP_ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  mkdirSync(app.getPath('userData'), { recursive: true });
  allowedServer = loadServerOrigin(app.getPath('userData'));

  // Serves the built page from rendererDir. Only the HTML response carries the policy; scripts and styles don't need it.
  protocol.handle('app', async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = normalize(join(rendererDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(rendererDir + sep)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).href);
    if (!file.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', buildCsp(allowedServer));
    return new Response(res.body, { status: res.status, headers });
  });
  // The renderer calls this with the server it is about to use. Returns true when that server differs from the
  // one the page was loaded with, so the renderer must reload to get a policy that allows it. A new server is confirmed
  // in a native dialog: page script can't click it, so a compromised page can't widen its own connection rules.
  ipcMain.handle('server:allow', async (e, raw: string) => {
    const origin = serverOrigin(String(raw ?? ''));
    if (origin === allowedServer) return false;
    if (origin) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) ?? undefined as unknown as BrowserWindow, {
        type: 'question', buttons: ['Connect', 'Cancel'], defaultId: 0, cancelId: 1,
        title: 'Chatward', message: `Connect to ${origin}?`,
        detail: 'Chatward will only reach this server, and the voice server on the same address.',
      });
      if (response !== 0) throw new Error('Connection to that server was cancelled.');
    }
    allowedServer = origin;
    saveServerOrigin(app.getPath('userData'), origin);
    return true;
  });

  // Permissions: only media (mic/camera/screen) + clipboard-sanitized-write, and only for the app's own page.
  // Frames embedded in messages (YouTube, X previews) must not get the microphone, camera or screen.
  // Fullscreen is the exception: a YouTube embed's own fullscreen button asks from its frame, so it is allowed for
  // any frame inside the app's window (the iframe's allow="fullscreen" already limits which frames can ask).
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (perm === 'fullscreen') return cb(isAppPage(details.requestingUrl) || appWindowContents.has(wc));
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(perm) && isAppPage(details.requestingUrl));
  });

  // Screen share: renderer first calls chatward.getScreenSources(), user picks, then
  // chatward.selectScreenSource(id) and getDisplayMedia() resolves with that source.
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    if (!isAppPage(req.frame?.url)) return cb({});
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
    // Never fall back to plain text: keys and history secrets would sit readable on disk.
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this computer, so Chatward will not save keys unprotected.');
    const s = readStore();
    s[key] = safeStorage.encryptString(value).toString('base64');
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

  // The page's own title bar buttons. `target` names a pop-out this page opened; without it the sender's own window.
  ipcMain.on('window:control', (e, action: unknown, target: unknown) => {
    const win = controlledWindow(e.sender, target);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });
  ipcMain.handle('window:maximized', (e, target: unknown) => controlledWindow(e.sender, target)?.isMaximized() ?? false);

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
