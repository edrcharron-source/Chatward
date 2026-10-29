// Filled in at build time by electron.vite.config.ts.
declare const __CHATWARD_BUILD__: {
  /** test: a CI installer from develop or main, installed as "Chatward Test". release: a tagged release. dev: anything else. */
  channel: 'test' | 'release' | 'dev';
  branch: string;
  /** Short commit hash. */
  commit: string;
  /** ISO time the build was made. */
  builtAt: string;
};
