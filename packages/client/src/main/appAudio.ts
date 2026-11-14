// Sharing one app window with its sound: records only that app's sound, never the whole computer or the voice chat.
//
// Electron can only share the whole computer's sound, so a small Windows helper (native/app-audio) records the one
// app that owns the shared window and writes its sound as raw 48 kHz stereo 16-bit PCM. This file starts and stops
// the helper and passes the sound to the page, which turns it into the share's audio track.
import { app, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** What the page is told: 'ok' (sound is coming), or why this window's sound can't be shared on its own. */
export type AppAudioResult = 'ok' | 'unsupported' | 'own-app' | 'failed';

const WINDOW_SOURCE = /^window:(\d+):\d+$/;
// One whole frame (2 channels x 2 bytes) at a time, so the page never sees half a sample.
const FRAME_BYTES = 4;
// The helper exits at once when it can't record; past this it is running.
const STARTUP_MS = 1500;

let current: { helper: ChildProcess; owner: WebContents } | null = null;

function helperPath(): string {
  const name = 'chatward-app-audio.exe';
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name);
}

/** Starts sending the sound of the app that owns `sourceId` (a desktopCapturer window id) to `owner`. */
export function startAppAudio(owner: WebContents, sourceId: string): Promise<AppAudioResult> {
  stopAppAudio();
  const match = WINDOW_SOURCE.exec(sourceId);
  const path = helperPath();
  if (process.platform !== 'win32' || !match || !existsSync(path)) return Promise.resolve('unsupported');

  const helper = spawn(path, [match[1], String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  current = { helper, owner };
  let leftover: Buffer = Buffer.alloc(0);
  helper.stdout?.on('data', (chunk: Buffer) => {
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const whole = data.length - (data.length % FRAME_BYTES);
    leftover = data.subarray(whole);
    if (whole > 0 && !owner.isDestroyed()) owner.send('app-audio:data', data.subarray(0, whole));
  });
  owner.once('destroyed', () => { if (current?.helper === helper) stopAppAudio(); });

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('ok'), STARTUP_MS);
    helper.once('error', () => { clearTimeout(timer); resolve('failed'); });
    helper.once('exit', (code) => {
      if (current?.helper === helper) current = null;
      clearTimeout(timer);
      // Exit codes are documented in native/app-audio/main.cpp.
      resolve(code === 3 ? 'own-app' : code === 4 ? 'unsupported' : 'failed');
      if (!owner.isDestroyed()) owner.send('app-audio:ended');
    });
  });
}

export function stopAppAudio(): void {
  if (!current) return;
  const { helper } = current;
  current = null;
  helper.stdin?.destroy();
  helper.stdout?.destroy();
  helper.kill();
}
