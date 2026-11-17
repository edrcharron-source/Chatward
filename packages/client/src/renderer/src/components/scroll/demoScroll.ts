// The demo server has no Scroll routes, so demo mode keeps likes and comments in memory for the session.
import type { MessagePayload, ScrollComment, ScrollSocial } from '@chatward/shared';
import { mockSlideIds } from './mockSlides';

type Gif = NonNullable<MessagePayload['gif']>;

const likes = new Map<string, Set<string>>();
const comments = new Map<string, ScrollComment[]>();
const YOU = 'you';

/** Some likes already there, so the feed does not look empty. Stable per item. */
function seededLikes(itemId: string): Set<string> {
  let set = likes.get(itemId);
  if (!set) {
    set = new Set();
    const n = 1 + (itemId.length * 7 + itemId.charCodeAt(itemId.length - 1)) % 9;
    for (let i = 0; i < n; i++) set.add(`bot-${i}`);
    likes.set(itemId, set);
  }
  return set;
}

const socialOf = (itemId: string): ScrollSocial => ({
  count: seededLikes(itemId).size,
  liked: seededLikes(itemId).has(YOU),
  comments: (comments.get(itemId) ?? []).length,
});

export const demoScroll = {
  social(): Record<string, ScrollSocial> {
    const out: Record<string, ScrollSocial> = {};
    for (const id of mockSlideIds()) out[id] = socialOf(id);
    return out;
  },
  like(itemId: string, liked: boolean): ScrollSocial {
    const set = seededLikes(itemId);
    if (liked) set.add(YOU);
    else set.delete(YOU);
    return socialOf(itemId);
  },
  comments(itemId: string): ScrollComment[] {
    return (comments.get(itemId) ?? []).slice();
  },
  add(itemId: string, text: string, gif: Gif | null): ScrollComment {
    const c: ScrollComment = { id: `demo-c-${Math.random().toString(36).slice(2, 10)}`, itemId, authorId: YOU, text, gif, createdAt: Date.now() };
    comments.set(itemId, [...(comments.get(itemId) ?? []), c]);
    return c;
  },
  remove(commentId: string): void {
    for (const [itemId, list] of comments) comments.set(itemId, list.filter((c) => c.id !== commentId));
  },
};
