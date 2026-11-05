import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// The web app: the same renderer the desktop app uses, built for a browser and served by the Chatward server itself
// (CHATWARD_WEB_DIR). It is what an iPhone adds to its home screen. window.chatward comes from src/renderer/src/web/bridge.ts.
function git(args: string): string {
  try { return execSync(`git ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}
const build = {
  channel: process.env.CHATWARD_BUILD_CHANNEL === 'test' || process.env.CHATWARD_BUILD_CHANNEL === 'release' ? process.env.CHATWARD_BUILD_CHANNEL : 'dev',
  branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git('rev-parse --abbrev-ref HEAD') || 'unknown',
  commit: (process.env.CHATWARD_COMMIT || process.env.GITHUB_SHA || git('rev-parse HEAD') || 'unknown').slice(0, 7),
  builtAt: new Date().toISOString(),
  defaultServer: '',
  web: true,
};

/** The tags that make the page an installable app on iPhone and Android. Only the web build gets them.
 *  The status bar is 'default' (solid), not 'black-translucent': since iOS 26 the iPhone puts a soft blur over the
 *  top of a home-screen app that draws under a see-through status bar, which made our top bar look out of focus.
 *  With a solid bar the page starts below it. Its colour follows theme-color, which web/statusBar.ts keeps matched
 *  to the skin. iPhone reads this tag when the app is added, so an existing icon must be removed and added again. */
const pwaTags: Plugin = {
  name: 'chatward-pwa-tags',
  transformIndexHtml(html) {
    return html
      .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#16181c" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Chatward" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />`)
      // The browser loads the page from the server, so the server's own address is 'self'. The desktop app's
      // connection rules allow any server; the web app only ever talks to its own.
      .replace('connect-src \'self\' http: https: ws: wss: blob:', 'connect-src \'self\' wss: blob:');
  },
};

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'web'),
  base: '/',
  plugins: [react(), pwaTags],
  define: { __CHATWARD_BUILD__: JSON.stringify(build) },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true },
});
