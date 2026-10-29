import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Which build this is, shown on the login screen and in the demo banner so a tester can tell what they are running.
// CI sets CHATWARD_BUILD_CHANNEL (test or release); GitHub Actions also gives the branch and commit. Elsewhere git is asked.
function git(args: string): string {
  try { return execSync(`git ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}
const channel = process.env.CHATWARD_BUILD_CHANNEL === 'test' || process.env.CHATWARD_BUILD_CHANNEL === 'release' ? process.env.CHATWARD_BUILD_CHANNEL : 'dev';
const build = {
  channel,
  branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git('rev-parse --abbrev-ref HEAD') || 'unknown',
  commit: (process.env.GITHUB_SHA || git('rev-parse HEAD') || 'unknown').slice(0, 7),
  builtAt: new Date().toISOString(),
};
const define = { __CHATWARD_BUILD__: JSON.stringify(build) };

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], define, build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } } },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    define,
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
