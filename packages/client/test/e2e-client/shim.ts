// Node stand-in for the Electron preload. Must be imported before any app module.
// Each device process gets its own store, which is what a real install would have.
const store = new Map<string, string>();

Object.assign(globalThis, {
  window: globalThis,
  chatward: {
    secureStore: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async set(key: string, value: string) {
        store.set(key, value);
      },
    },
  },
});

export const secureStoreContents = store;
