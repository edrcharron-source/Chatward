// @mentions. A mention is plain "@Name" text in the message, and the list of who it pings travels inside the
// encrypted payload (MessagePayload.mentions), so the server never sees it and older clients just ignore it.
import type { Member, MessagePayload } from '@chatward/shared';

export const EVERYONE = 'everyone';
const WORD = /[\p{L}\p{N}_]/u;
const MAX_QUERY = 40;

export interface MentionOption {
  /** What gets inserted after the @. */
  name: string;
  /** Shown beside the name in the picker. */
  note: string;
  everyone?: boolean;
  userId?: string;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name matches when "@name" is not glued onto a longer word on either side. */
function namePattern(name: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(name)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
}

/** Who a message text pings, using the server's members. Undefined when it pings nobody. */
export function parseMentions(text: string, members: Member[]): MessagePayload['mentions'] {
  const everyone = namePattern(EVERYONE).test(text);
  const userIds = members
    .filter((m) => namePattern(m.user.displayName).test(text))
    .map((m) => m.user.id);
  if (!everyone && userIds.length === 0) return undefined;
  return { ...(everyone ? { everyone: true } : {}), userIds };
}

/** Whether this payload pings the given user (directly, or through @everyone). */
export function pings(mentions: MessagePayload['mentions'] | undefined, userId: string | undefined): boolean {
  if (!mentions || !userId) return false;
  return !!mentions.everyone || mentions.userIds.includes(userId);
}

/** The @ being typed just before the caret, if any: where it starts and what has been typed after it. */
export function activeMention(text: string, caret: number): { at: number; query: string } | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0) return null;
  if (at > 0 && WORD.test(text[at - 1])) return null;
  const query = text.slice(at + 1, caret);
  if (query.length > MAX_QUERY || query.includes('\n')) return null;
  return { at, query };
}

/** Picker entries for a query: @everyone first, then members whose names start with it, then names containing it. */
export function mentionOptions(query: string, members: Member[]): MentionOption[] {
  const q = query.toLowerCase();
  const everyone: MentionOption[] = EVERYONE.startsWith(q)
    ? [{ name: EVERYONE, note: 'Ping everyone in this server', everyone: true }]
    : [];
  const people = members
    .filter((m) => m.user.displayName.toLowerCase().includes(q))
    .sort((a, b) => {
      const sa = a.user.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      const sb = b.user.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      return sa - sb || a.user.displayName.localeCompare(b.user.displayName);
    })
    .map((m) => ({ name: m.user.displayName, note: `@${m.user.username}`, userId: m.user.id }));
  return [...everyone, ...people].slice(0, 8);
}
