// Public surface of the chat-media feature. OWNER: chat-media thread. Signatures are the contract.
import type { ReactElement } from 'react';
import type { Attachment, LinkPreview, MessagePayload } from '@chatward/shared';

/** Compress/resize (max 1600px, JPEG/WebP ~0.82; keep GIF/PNG-with-alpha sensibly), encrypt, upload. */
export async function uploadAttachment(_file: File): Promise<Attachment> { throw new Error('stub'); }
/** Renders an image attachment (fetch encrypted blob, decrypt, show; click to enlarge). Non-images: download chip. */
export function AttachmentView(_p: { attachment: Attachment }): ReactElement | null { return null; }
export function EmojiPickerButton(_p: { onPick: (emoji: string) => void }): ReactElement | null { return null; }
export function GifPickerButton(_p: { onPick: (gif: NonNullable<MessagePayload['gif']>) => void }): ReactElement | null { return null; }
export function GifView(_p: { gif: NonNullable<MessagePayload['gif']> }): ReactElement | null { return null; }
export function extractUrls(_text: string): string[] { return []; }
/** Sender-side: fetch previews via /api/linkpreview (max 3 urls), respecting settings.linkPreviews. Never throws. */
export async function buildLinkPreviews(_urls: string[]): Promise<LinkPreview[]> { return []; }
/** Card; YouTube/X embeds are click-to-load unless settings.autoLoadEmbeds. */
export function LinkPreviewCard(_p: { preview: LinkPreview }): ReactElement | null { return null; }
