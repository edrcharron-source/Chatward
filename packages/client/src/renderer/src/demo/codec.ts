// Demo "ciphertext": base64 of UTF-8 JSON. Nothing leaves the PC in demo mode, so nothing is encrypted.
import type { MessagePayload } from '@chatward/shared';

export function demoEncode(payload: MessagePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return btoa(String.fromCharCode(...bytes));
}

export function demoDecode(ciphertext: string): MessagePayload | null {
  try {
    const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as MessagePayload;
    return typeof payload.text === 'string' ? payload : null;
  } catch {
    return null;
  }
}
