// The matching rules for chat search, kept free of app state so they can be tested on their own.
import type { Attachment, Message, MessagePayload } from '@chatward/shared';

/** What a message must carry: anything, a picture/video/GIF, a file of another kind, or a link. */
export type SearchKind = 'any' | 'media' | 'files' | 'links';

export interface SearchFilters {
  text: string;
  /** Only messages from this person; '' for anyone. */
  authorId: string;
  kind: SearchKind;
}

export interface SearchEntry {
  message: Message;
  /** null = could not be decrypted (yet), so only the person and kind filters can match it. */
  payload: MessagePayload | null;
}

export const isMediaAttachment = (a: Attachment) => a.mime.startsWith('image/') || a.mime.startsWith('video/');

export function hasKind(p: MessagePayload, kind: SearchKind): boolean {
  switch (kind) {
    case 'any': return true;
    case 'media': return !!p.gif || !!p.attachments?.some(isMediaAttachment);
    case 'files': return !!p.attachments?.some((a) => !isMediaAttachment(a));
    case 'links': return !!p.linkPreviews?.length || /https?:\/\/\S/i.test(p.text);
  }
}

/** The lower-cased words of a search. Every one must appear in a message for it to match. */
export const searchWords = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Everything in a message a search looks through: its text, file names, GIF title and link titles. */
function haystack(p: MessagePayload): string {
  const parts = [p.text];
  for (const a of p.attachments ?? []) parts.push(a.name);
  if (p.gif?.title) parts.push(p.gif.title);
  for (const l of p.linkPreviews ?? []) parts.push(l.title ?? '', l.siteName ?? '');
  return parts.join('\n').toLowerCase();
}

/** True when the filters ask for something; with none set, a search lists nothing rather than every message. */
export const isSearching = (f: SearchFilters) => f.text.trim() !== '' || f.authorId !== '' || f.kind !== 'any';

export function matches(e: SearchEntry, f: SearchFilters, words = searchWords(f.text)): boolean {
  if (f.authorId && e.message.authorId !== f.authorId) return false;
  if (!e.payload) return false;
  if (!hasKind(e.payload, f.kind)) return false;
  if (words.length === 0) return true;
  const hay = haystack(e.payload);
  return words.every((w) => hay.includes(w));
}

/** The matching messages, newest first. */
export function searchEntries(entries: Iterable<SearchEntry>, f: SearchFilters): SearchEntry[] {
  if (!isSearching(f)) return [];
  const words = searchWords(f.text);
  const hits: SearchEntry[] = [];
  for (const e of entries) if (matches(e, f, words)) hits.push(e);
  return hits.sort((a, b) => b.message.createdAt - a.message.createdAt || (a.message.id < b.message.id ? 1 : -1));
}

/**
 * A short piece of the text around the first word found, split so the found words can be marked.
 * Odd items of the result are the found words.
 */
export function snippet(text: string, words: string[], width = 140): string[] {
  const lower = text.toLowerCase();
  let start = 0;
  if (text.length > width && words.length) {
    const first = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
    if (Number.isFinite(first)) start = Math.max(0, first - Math.floor(width / 3));
  }
  let piece = text.slice(start, start + width);
  if (start > 0) piece = `…${piece}`;
  if (start + width < text.length) piece = `${piece}…`;
  if (!words.length) return [piece];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  return piece.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
}
