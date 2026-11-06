// Filled in at build time by electron.vite.config.ts.
declare const __CHATWARD_BUILD__: {
  /** test: a CI installer from develop or main, installed as "Chatward Test". release: a tagged release. dev: anything else. */
  channel: 'test' | 'release' | 'dev';
  branch: string;
  /** Short commit hash. */
  commit: string;
  /** ISO time the build was made. */
  builtAt: string;
  /** Server address a fresh install starts with, or empty for the local dev server. */
  defaultServer: string;
  /** True in the web app build (vite.web.config.ts): the page is served by the Chatward server and runs in a browser. */
  web?: boolean;
};
/** The Spotify app's client ID (SPOTIFY_CLIENT_ID at build time), or empty. Main process only. */
declare const __SPOTIFY_CLIENT_ID__: string;
/** PEM public key that update installers must be signed with (CHATWARD_UPDATE_PUBLIC_KEY at build time), or empty. Main process only. */
declare const __CHATWARD_UPDATE_KEY__: string;
