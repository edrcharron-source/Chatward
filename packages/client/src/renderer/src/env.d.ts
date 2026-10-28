/// <reference types="vite/client" />
import type { ChatwardApi } from '../../preload/index';
declare global {
  interface Window { chatward: ChatwardApi }
}
export {};
