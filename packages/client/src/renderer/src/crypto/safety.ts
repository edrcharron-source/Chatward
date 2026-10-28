// Safety number: 30 digits in six groups of five, derived from every device's signing key.
// Two people who compare the same string are looking at the same set of devices.
import type { DeviceKeys } from '@chatward/shared';
import { sha256, utf8 } from './primitives';

const GROUPS = 6;

export async function safetyNumber(devices: DeviceKeys[]): Promise<string> {
  const keys = devices.map((d) => d.signPublic).sort();
  const digest = await sha256(utf8(keys.join('\n')));
  const view = new DataView(digest.buffer);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(String(view.getUint32(g * 4) % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}
