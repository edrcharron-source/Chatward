import { app, BaseWindow, BrowserWindow, WebContentsView, dialog, ipcMain, net, protocol, safeStorage, desktopCapturer, screen, session, shell } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { copyGifLink, copyImage, fetchGif } from './copyImage';
import { fetchLinkPreview } from './linkPreview';
import { searchGifs } from './klipy';
import { connectSpotify, disconnectSpotify, nowPlaying, pausePlayback, playTrack, resolveJamLink, spotifyStatus, type TokenStore } from './spotify';
import { setupUpdater } from './updater';
import { APP_ORIGIN, buildCsp, loadServerOrigin, saveServerOrigin, serverOrigin } from './serverPolicy';
import { fitWindow, isResizeEdge, resizeBounds } from './windowBounds';
import { ResizePacer } from './resizePacing';
import { startAppAudio, stopAppAudio } from './appAudio';

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

const writeSecret = (key: string, value: string) => {
  // Never fall back to plain text: keys and history secrets would sit readable on disk.
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this computer, so Chatward will not save keys unprotected.');
  const s = readStore();
  s[key] = safeStorage.encryptString(value).toString('base64');
  writeStore(s);
};
const removeSecret = (key: string) => {
  const s = readStore();
  if (!(key in s)) return;
  delete s[key];
  writeStore(s);
};
const spotifyStore: TokenStore = { get: readSecret, set: writeSecret, remove: removeSecret };

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
      // Picture in picture: a small window that stays on top of other windows (the page names it chatward-watch-pip).
      const pip = frameName === 'chatward-watch-pip';
      return { action: 'allow', overrideBrowserWindowOptions: { width: pip ? 480 : 960, height: pip ? 300 : 540, minWidth: pip ? 320 : undefined, minHeight: pip ? 200 : undefined, alwaysOnTop: pip, resizable: true, autoHideMenuBar: true, titleBarStyle: 'hidden', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } } };
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

/**
 * The app's page lives in a view that can be moved from one window to another without reloading (see swapWindow).
 * This maps the page to the main window it is in right now. Pop-outs are ordinary windows with their own page.
 */
const hosts = new Map<Electron.WebContents, BaseWindow>();
function windowOf(sender: Electron.WebContents): BaseWindow | null {
  return hosts.get(sender) ?? BrowserWindow.fromWebContents(sender);
}
/** True when the sender is the app's main page itself, not a pop-out or a frame inside it. */
const isMainPage = (sender: Electron.WebContents) => hosts.has(sender);

function controlledWindow(sender: Electron.WebContents, target: unknown): BaseWindow | null {
  if (typeof target === 'string' && target) {
    const child = childWindows.get(sender)?.get(target);
    return child && !child.isDestroyed() ? child : null;
  }
  return windowOf(sender);
}

/**
 * The LCARS layout's frame is not a rectangle, so the main window can be a "shaped" one: transparent, with no system
 * border, shadow or rounded corners, and the page paints only the frame (lcars.css). Windows can only make a window
 * transparent when it is created, so switching the layout in or out of LCARS puts the page into a new window of the
 * other kind (see swapWindow). The page itself is moved, not reloaded, so everything on it carries on as it was. The
 * choice is saved so the app starts in the right window. Every other layout keeps the usual window.
 */
const FRAME_FILE = 'window-frame.json';
function loadShaped(): boolean {
  try { return JSON.parse(readFileSync(join(app.getPath('userData'), FRAME_FILE), 'utf8'))?.shaped === true; } catch { return false; }
}
function saveShaped(shaped: boolean): void {
  try { writeFileSync(join(app.getPath('userData'), FRAME_FILE), JSON.stringify({ shaped })); } catch { /* the next start uses the usual window */ }
}
const shapedWindows = new WeakSet<BaseWindow>();
/** The app's main windows (not pop-outs) and the page each one shows. */
const mainPages = new WeakMap<BaseWindow, WebContentsView>();
const MIN_SIZE = { width: 900, height: 600 };

/** An edge drag in progress on a shaped window (it has no system border to drag): the cursor is followed until the page says the button is up. */
let resizing: { win: BaseWindow; timer: NodeJS.Timeout; pacer: ResizePacer } | null = null;
function stopResize(): void {
  if (!resizing) return;
  clearInterval(resizing.timer);
  if (!resizing.win.isDestroyed()) resizing.win.off('blur', stopResize);
  resizing = null;
}

/** The page fills the window's inside. */
function fitPage(win: BaseWindow): void {
  const view = mainPages.get(win);
  if (!view || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
}

/** A main window, shaped or not, showing `view` (a new page when none is given). */
function createWindow(place?: { bounds: Electron.Rectangle; maximized: boolean }, view?: WebContentsView, shapedChoice?: boolean) {
  // Fit to the primary display's work area so the bottom edge is not hidden behind the taskbar on small or scaled screens.
  const fitted = fitWindow(screen.getPrimaryDisplay().workArea, { width: 1280, height: 800, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height });
  const bounds = place ? { ...place.bounds, minWidth: fitted.minWidth, minHeight: fitted.minHeight } : fitted;
  const shaped = shapedChoice ?? (process.platform !== 'darwin' && !app.commandLine.hasSwitch('chatward-keep-window') && loadShaped());
  const win = new BaseWindow({
    ...bounds,
    // A moved page is put in before the window shows, so the new window never flashes empty.
    show: !view,
    title: 'Chatward',
    // The app icon shown in the taskbar. Packaged builds include build/icon.png (see package.json "files").
    icon: join(app.getAppPath(), 'build/icon.png'),
    autoHideMenuBar: true,
    ...(shaped
      // Nothing of the window's own: no fill, frame, shadow or rounded corners, so only the page's LCARS frame shows.
      ? { frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false, roundedCorners: false }
      // No system frame: the page draws its own title bar (components/titlebar). 'hidden' keeps the edge resizing,
      // the shadow and Windows snap that frame: false would lose. macOS keeps its traffic lights.
      : { backgroundColor: '#1e1f22', titleBarStyle: 'hidden' as const }),
  });
  const page = view ?? new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // Tells the page whether it starts in a shaped window; a move to another window says so with window:shaped-changed.
      additionalArguments: shaped ? ['--chatward-shaped'] : [],
    },
  });
  // A see-through page in the shaped window, so the desktop shows past the LCARS frame.
  page.setBackgroundColor(shaped ? '#00000000' : '#1e1f22');
  win.contentView.addChildView(page);
  mainPages.set(win, page);
  hosts.set(page.webContents, win);
  if (shaped) shapedWindows.add(win);
  fitPage(win);
  win.on('resize', () => fitPage(win));
  // Once the user looks at the window, the taskbar flash has done its job, so stop it; typing goes to the page.
  win.on('focus', () => {
    win.flashFrame(false);
    if (mainPages.get(win) === page && !page.webContents.isDestroyed()) page.webContents.focus();
  });
  win.on('closed', () => {
    if (resizing?.win === win) stopResize();
    // A window closed by the user takes its page with it. A swap has already moved the page on.
    if (hosts.get(page.webContents) === win) {
      hosts.delete(page.webContents);
      if (!page.webContents.isDestroyed()) page.webContents.close();
    }
  });
  if (place?.maximized) win.maximize();
  if (view) {
    win.show();
    page.webContents.focus();
    page.webContents.send('window:shaped-changed', shaped);
    return win;
  }

  const wc = page.webContents;
  guardWebContents(wc);
  appWindowContents.add(wc);
  wc.on('destroyed', () => { hosts.delete(wc); });
  // Child windows (the watch-party pop-out) don't inherit the handlers above, so guard them too.
  // They live on this page, so they close with it (not with the window: a layout swap moves the page on).
  wc.on('did-create-window', (child, { frameName }) => {
    guardWebContents(child.webContents);
    appWindowContents.add(child.webContents);
    if (frameName) {
      const named = childWindows.get(wc) ?? new Map<string, BrowserWindow>();
      childWindows.set(wc, named);
      named.set(frameName, child);
      child.on('closed', () => { if (named.get(frameName) === child) named.delete(frameName); });
    }
    wc.once('destroyed', () => { if (!child.isDestroyed()) child.close(); });
  });
  if (process.env['ELECTRON_RENDERER_URL']) wc.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else wc.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/** Moves the page into a new window of the other kind, at the same place and size, without reloading it. */
function swapWindow(win: BaseWindow, shaped: boolean): void {
  const page = mainPages.get(win);
  if (!page) return;
  const place = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  if (resizing?.win === win) stopResize();
  win.contentView.removeChildView(page);
  mainPages.delete(win);
  createWindow(place, page, shaped);
  win.destroy();
}

/** Pending window swaps, so a layout flipped back and forth quickly (or a page that mounts twice) swaps at most once. */
const swapTimers = new WeakMap<Electron.WebContents, NodeJS.Timeout>();

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
      const { response } = await dialog.showMessageBox(windowOf(e.sender) ?? undefined as unknown as BaseWindow, {
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
    // 'loopback' captures system audio on Windows and is only used when the page asks for audio (whole-screen shares).
    // The page asks with restrictOwnAudio, so Chromium leaves Chatward's own sound (the voice chat) out where Windows
    // allows it. A shared window's sound comes from appAudio.ts instead, so only that app is heard.
    if (chosen) cb({ video: chosen, audio: 'loopback' });
    else cb({});
  });

  sendReferrerForYouTube();
  setupUpdater(() => [...hosts.keys()]);

  ipcMain.handle('secure:get', (_e, key: string) => readSecret(key));
  // Demo-only internet access. Both run here so the renderer's CSP and CORS never apply.
  ipcMain.handle('demo:linkpreview', (_e, url: string) => fetchLinkPreview(String(url)));
  ipcMain.handle('demo:gifs', (_e, kind: 'search' | 'trending', q: string, pos?: string) =>
    searchGifs(readSecret(KLIPY_KEY_STORE)?.trim() || null, kind === 'search' ? 'search' : 'trending', String(q ?? ''), pos));
  ipcMain.handle('secure:set', (_e, key: string, value: string) => writeSecret(key, value));
  // Spotify "listening to". Tokens stay in this process; the page only sees the track.
  ipcMain.handle('spotify:status', () => spotifyStatus(spotifyStore));
  ipcMain.handle('spotify:connect', () => connectSpotify(spotifyStore));
  ipcMain.handle('spotify:disconnect', () => disconnectSpotify(spotifyStore));
  ipcMain.handle('spotify:now-playing', () => nowPlaying(spotifyStore));
  ipcMain.handle('spotify:play', (_e, url: string, positionMs: number) => playTrack(spotifyStore, String(url ?? ''), Number(positionMs)));
  ipcMain.handle('spotify:pause', () => pausePlayback(spotifyStore));
  ipcMain.handle('spotify:resolve-jam', (_e, url: string) => resolveJamLink(String(url ?? '')));
  // Right-click "Copy image" on chat pictures. Only the app's own windows may write the clipboard this way.
  const fromApp = (e: Electron.IpcMainInvokeEvent) => {
    if (!appWindowContents.has(e.sender)) throw new Error('Not allowed.');
  };
  ipcMain.handle('clipboard:copy-image', (e, req: unknown) => { fromApp(e); return copyImage(req); });
  ipcMain.handle('clipboard:copy-gif-link', (e, url: unknown) => { fromApp(e); return copyGifLink(url); });
  ipcMain.handle('media:fetch-gif', (e, url: unknown) => { fromApp(e); return fetchGif(url); });
  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon?.toDataURL() ?? null, isScreen: s.id.startsWith('screen:') }));
  });
  ipcMain.handle('screen:select', (_e, id: string) => { pendingSourceId = id; });
  // Sharing one window with sound: only that app's sound, recorded by a small helper (see appAudio.ts).
  ipcMain.handle('app-audio:start', (e, id: unknown) => { fromApp(e); return startAppAudio(e.sender, String(id ?? '')); });
  ipcMain.on('app-audio:stop', () => stopAppAudio());
  // The renderer asks for a taskbar flash only for messages the user should see. Skip it if they are already looking.
  ipcMain.on('window:flash', (e) => {
    const win = windowOf(e.sender);
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
  // The page says whether its layout wants the shaped window (LCARS) or the usual one. When that differs from the
  // window it is in, the choice is saved and the page moves to a new window of the right kind at the same place and
  // size. The page is not reloaded: it carries on as it was, call and all.
  ipcMain.on('window:shaped', (e, want: unknown) => {
    const win = hosts.get(e.sender);
    if (!win || typeof want !== 'boolean') return;
    // The screenshot checks hold on to the first window, so they ask for it to be kept.
    if (process.platform === 'darwin' || app.commandLine.hasSwitch('chatward-keep-window')) return;
    clearTimeout(swapTimers.get(e.sender));
    swapTimers.set(e.sender, setTimeout(() => {
      swapTimers.delete(e.sender);
      const now = hosts.get(e.sender);
      if (!now || now.isDestroyed()) return;
      saveShaped(want);
      if (shapedWindows.has(now) !== want) swapWindow(now, want);
    }, 150));
  });
  // A shaped window has no system border, so the LCARS frame's edges start the resize themselves.
  ipcMain.on('window:resize', (e, edge: unknown) => {
    const win = hosts.get(e.sender);
    stopResize();
    if (!win || !isResizeEdge(edge) || win.isMaximized() || win.isFullScreen()) return;
    const start = win.getBounds();
    const from = screen.getCursorScreenPoint();
    const [minW, minH] = win.getMinimumSize();
    // One step at a time: the next size waits until the page has drawn the last one (window:resize-ack).
    const pacer = new ResizePacer();
    const timer = setInterval(() => {
      if (win.isDestroyed()) return stopResize();
      const tick = Date.now();
      if (!pacer.ready(tick)) return;
      const at = screen.getCursorScreenPoint();
      const next = resizeBounds(start, edge, at.x - from.x, at.y - from.y, { width: minW || MIN_SIZE.width, height: minH || MIN_SIZE.height });
      const now = win.getBounds();
      if (next.x !== now.x || next.y !== now.y || next.width !== now.width || next.height !== now.height) {
        win.setBounds(next);
        fitPage(win);
        pacer.sent(tick);
      }
    }, 16);
    resizing = { win, timer, pacer };
    // A button released outside the window never reaches the page, so stop when the window loses focus too.
    win.on('blur', stopResize);
  });
  ipcMain.on('window:resize-end', () => stopResize());
  // The page has drawn the size the window was last moved to, so the next step may go ahead.
  ipcMain.on('window:resize-ack', (e) => {
    if (resizing && hosts.get(e.sender) === resizing.win) resizing.pacer.acked();
  });
  ipcMain.handle('window:maximized', (e, target: unknown) => controlledWindow(e.sender, target)?.isMaximized() ?? false);

  createWindow();
  app.on('activate', () => { if (BaseWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', stopAppAudio);
