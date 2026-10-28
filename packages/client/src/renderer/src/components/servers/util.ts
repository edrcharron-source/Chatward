import type { Channel, Member } from '@chatward/shared';

export function firstTextId(channels: Channel[]): string | null {
  return channels.find((c) => c.kind === 'text')?.id ?? null;
}

export function isAdmin(member: Member | undefined): boolean {
  return member?.role === 'owner' || member?.role === 'admin';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
