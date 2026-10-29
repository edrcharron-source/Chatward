import type { Member } from '@chatward/shared';

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
