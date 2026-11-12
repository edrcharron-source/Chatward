import { api } from '../api/http';

/**
 * Notifications for the web app (Web Push). On an iPhone they only work in the app added to the home screen
 * (iOS 16.4 or later), and only after a tap, so the switch lives in a button rather than turning on by itself.
 */
export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function supported(): boolean {
  return __CHATWARD_BUILD__.web === true && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (__CHATWARD_BUILD__.web !== true) return 'unsupported';
  if (isIos() && !standalone()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/api/push/key');
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.post('/api/push/subscribe', sub.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return 'off';
}

export const testPush = () => api.post<{ delivered: boolean }>('/api/push/test');

/**
 * Run when the app opens. If notifications were turned on here, make sure the server still has this device's
 * subscription: iPhone can replace it, and the server drops ones that stopped working. Also clears the app icon's badge
 * and the notifications already on screen, since the app is now open.
 */
export async function syncPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await api.post('/api/push/subscribe', sub.toJSON());
  else await enablePush();
}

export async function clearNotifications(): Promise<void> {
  if (__CHATWARD_BUILD__.web !== true) return;
  try { await (navigator as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.(); } catch { /* not supported */ }
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const n of (await reg?.getNotifications()) ?? []) n.close();
}
