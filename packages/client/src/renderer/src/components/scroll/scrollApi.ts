import type { MessagePayload, ScrollComment, ScrollSocial } from '@chatward/shared';
import { api } from '../../api/http';
import { isDemo } from '../../demo';
import { demoScroll } from './demoScroll';

type Gif = NonNullable<MessagePayload['gif']>;

/** Likes and comment counts for every item in the server. Demo mode keeps them in memory. */
export async function getSocial(serverId: string): Promise<Record<string, ScrollSocial>> {
  if (isDemo()) return demoScroll.social();
  return (await api.get<{ items: Record<string, ScrollSocial> }>(`/api/servers/${serverId}/scroll`)).items;
}

export async function setLike(itemId: string, liked: boolean): Promise<ScrollSocial> {
  if (isDemo()) return demoScroll.like(itemId, liked);
  return api.post<ScrollSocial>(`/api/vault/${encodeURIComponent(itemId)}/like`, { liked });
}

export async function listComments(itemId: string): Promise<ScrollComment[]> {
  if (isDemo()) return demoScroll.comments(itemId);
  return (await api.get<{ comments: ScrollComment[] }>(`/api/vault/${encodeURIComponent(itemId)}/comments`)).comments;
}

export async function addComment(itemId: string, text: string, gif: Gif | null): Promise<ScrollComment> {
  if (isDemo()) return demoScroll.add(itemId, text, gif);
  return (await api.post<{ comment: ScrollComment }>(`/api/vault/${encodeURIComponent(itemId)}/comments`, { text, gif: gif ?? undefined })).comment;
}

export async function deleteComment(commentId: string): Promise<void> {
  if (isDemo()) return demoScroll.remove(commentId);
  await api.del(`/api/vault/comments/${encodeURIComponent(commentId)}`);
}
