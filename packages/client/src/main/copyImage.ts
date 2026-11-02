import { app, clipboard, ClipboardItem, nativeImage, net } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// "Copy image" from a picture's right-click menu. The page sends the picture as a PNG (and, for a GIF, the GIF file too);
// this puts it on the system clipboard.

/** Biggest file accepted from the page. Chat uploads are smaller than this. */
const MAX_BYTES = 64 * 1024 * 1024;
/** Hosts the GIF provider serves its files from (same list as the page's safeUrls.ts). */
const GIF_HOSTS = ['klipy.com'];

export interface CopyRequest {
  /** The picture as PNG: what apps that only take pictures (Paint, Word, most chat boxes) paste. */
  png: Uint8Array;
  /** The original GIF file. On Windows it goes on the clipboard as a file too, so Discord and Explorer keep the animation. */
  gif?: { bytes: Uint8Array; name: string };
}

function bytesOf(v: unknown): Uint8Array | null {
  if (!(v instanceof Uint8Array) || v.byteLength === 0 || v.byteLength > MAX_BYTES) return null;
  return v;
}

/** A file name that is safe on Windows: letters, digits, spaces, dashes and dots only, ending in .gif. */
export function gifFileName(raw: string): string {
  const base = raw.replace(/\.gif$/i, '').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60);
  return `${base || 'GIF'}.gif`;
}

/** The folder copied GIFs are written to. Only the newest copy is kept: the clipboard points at it until something else is copied. */
function copyDir(): string {
  const dir = join(app.getPath('temp'), 'Chatward copied pictures');
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  return dir;
}

/**
 * Puts a file and a picture on the Windows clipboard together, the way Explorer's Copy does plus the picture.
 * Electron can only put one of those on the clipboard, so this asks Windows' own PowerShell to do it.
 * Paths are passed in environment variables, never inside the command text.
 */
function copyFileAndPictureWindows(filePath: string, pngPath: string): Promise<void> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$files = New-Object System.Collections.Specialized.StringCollection',
    '[void]$files.Add($env:CHATWARD_COPY_FILE)',
    '$data = New-Object System.Windows.Forms.DataObject',
    '$data.SetFileDropList($files)',
    '$img = [System.Drawing.Image]::FromFile($env:CHATWARD_COPY_PNG)',
    '$data.SetImage($img)',
    '[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)',
    '$img.Dispose()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, CHATWARD_COPY_FILE: filePath, CHATWARD_COPY_PNG: pngPath } },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** Puts the picture on the clipboard. Resolves 'animated' when the GIF file went on too, 'still' when only the picture did. */
export async function copyImage(req: unknown): Promise<'animated' | 'still'> {
  const r = (req ?? {}) as Partial<CopyRequest>;
  const png = bytesOf(r.png);
  if (!png) throw new Error('That picture could not be copied.');
  const image = nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty()) throw new Error('That picture could not be copied.');

  const gif = r.gif && bytesOf(r.gif.bytes);
  if (gif && process.platform === 'win32') {
    try {
      const dir = copyDir();
      const filePath = join(dir, gifFileName(String(r.gif?.name ?? '')));
      const pngPath = join(dir, 'still.png');
      writeFileSync(filePath, gif);
      writeFileSync(pngPath, png);
      await copyFileAndPictureWindows(filePath, pngPath);
      return 'animated';
    } catch {
      // PowerShell missing or blocked: fall back to the still picture below.
    }
  }
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(png)], { type: 'image/png' }) })]);
  return 'still';
}

/** Copies a GIF provider link as text. Only links on the provider's own hosts. */
export async function copyGifLink(url: unknown): Promise<void> {
  const u = gifUrl(url);
  if (!u) throw new Error('That link can not be copied.');
  await clipboard.writeText(u);
}

function gifUrl(url: unknown): string | null {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol !== 'https:' || !GIF_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Downloads a GIF from the GIF provider for copying. The page's connection rules don't allow the provider (it may only
 * show its pictures), so the file is fetched here. Only the provider's own hosts, and only image responses.
 */
export async function fetchGif(url: unknown): Promise<Uint8Array> {
  const u = gifUrl(url);
  if (!u) throw new Error('That GIF can not be copied.');
  const res = await net.fetch(u, { redirect: 'error' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) throw new Error('That GIF could not be downloaded.');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('That GIF is too big to copy.');
  return buf;
}
