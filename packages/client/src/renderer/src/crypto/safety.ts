// Safety number: 30 digits in six groups of five, derived from every device's identity keys.
// Covers the ECDSA signing key (which signs each device's KeyPackages, so its MLS keys are covered too), the ECDH key
// (which wraps channel keys to the device), and the deviceId. Two people who compare the same string are looking at the same devices.
import type { DeviceKeys } from '@chatward/shared';
import { sha256, utf8 } from './primitives';

const GROUPS = 6;

export async function safetyNumber(devices: DeviceKeys[]): Promise<string> {
  const lines = devices.map((d) => `${d.deviceId}|${d.signPublic}|${d.ecdhPublic}`).sort();
  const digest = await sha256(utf8(lines.join('\n')));
  const view = new DataView(digest.buffer);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(String(view.getUint32(g * 4) % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}
