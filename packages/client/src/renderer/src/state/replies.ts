// Replies. A reply carries a link to the message it answers (MessagePayload.replyTo) inside the encrypted payload,
// and puts the original's author in `mentions`, so they get pinged exactly as if they had been @mentioned.
import type { MessagePayload, ReplyRef } from '@chatward/shared';

export const SNIPPET_MAX = 120;

/** A short, one-line copy of a message for the quote above a reply. Messages with no words say what they hold. */
export function snippetOf(payload: MessagePayload | null | undefined): string {
  const text = (payload?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : text;
  if (!payload) return 'Original message';
  if (payload.gif) return 'GIF';
  const files = payload.attachments ?? [];
  if (files.length) {
    const pictures = files.every((a) => a.mime.startsWith('image/') || a.mime.startsWith('video/'));
    if (pictures) return files.length === 1 ? (files[0].mime.startsWith('video/') ? 'Video' : 'Picture') : `${files.length} pictures`;
    return files.length === 1 ? files[0].name : `${files.length} files`;
  }
  if (payload.vault?.length) return payload.vault.length === 1 ? 'Vault item' : `${payload.vault.length} Vault items`;
  if (payload.listenAlong) return 'Listen Along invite';
  return 'Original message';
}

/** The mentions a reply sends: the typed @mentions plus the original's author (nobody pings themselves). */
export function withReplyPing(
  mentions: MessagePayload['mentions'],
  replyTo: ReplyRef | undefined,
  meId: string,
): MessagePayload['mentions'] {
  if (!replyTo || replyTo.authorId === meId) return mentions;
  const userIds = mentions?.userIds ?? [];
  if (userIds.includes(replyTo.authorId)) return mentions;
  return { ...(mentions ?? {}), userIds: [...userIds, replyTo.authorId] };
}
