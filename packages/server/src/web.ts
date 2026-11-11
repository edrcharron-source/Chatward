import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * The web app (Chatward in a browser, or added to an iPhone's home screen) is the desktop app's page, built for the
 * browser and served from here, so it is same-origin with the API and needs no CORS.
 *
 * helmet's default Content-Security-Policy is meant for the API and would block the page's blob: pictures, voice
 * and the watch party's YouTube player, so the page's files get the policy the page itself was written for instead.
 * It only lets the page talk to this server.
 */
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // WebAssembly only (the Vault's on-device photo sorter); still no eval of JavaScript
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://klipy.com https://*.klipy.com https://i.scdn.co https://i.ytimg.com",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' wss: blob:",
  'frame-src https://www.youtube-nocookie.com https://platform.twitter.com https://twitframe.com https://*.twitter.com https://*.x.com',
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Paths that belong to the server, never to the page. */
const SERVER_PATH = /^\/(api|ws|rtc|updates)(\/|$)/;

export function serveWebApp(app: express.Express, webDir: string): boolean {
  const index = path.join(webDir, 'index.html');
  if (!webDir || !fs.existsSync(index)) return false;
  app.use((req, res, next) => {
    if (SERVER_PATH.test(req.path)) { next(); return; }
    res.setHeader('Content-Security-Policy', WEB_CSP);
    next();
  });
  app.use(express.static(webDir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      // Built files carry a content hash in their name and never change; everything else is checked on each load.
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
      if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }));
  // Any other page address opens the app, which reads the address itself.
  app.get('*', (req, res, next) => {
    if (SERVER_PATH.test(req.path) || !req.accepts('html')) { next(); return; }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return true;
}
