import { LIMITS, type LinkPreview, type MessagePayload } from '@chatward/shared';

export const MESSAGE_TOO_LONG = 'That message is too long to send. Shorten it and try again.';

interface Sealed {
  ciphertext: string;
  keyVersion: number;
}

export type Fitted = Sealed & { payload: MessagePayload };

/** Replaces the preview list, or drops it when none is left. */
function withPreviews(payload: MessagePayload, linkPreviews?: LinkPreview[]): MessagePayload {
  const { linkPreviews: _previous, ...rest } = payload;
  return linkPreviews?.length ? { ...rest, linkPreviews } : rest;
}

/**
 * Encrypts a payload so its ciphertext fits the server cap. Link preview images are the usual overflow,
 * so each step gives up a little more: shrink the images, then drop them, then drop the previews.
 * Throws a readable error when even the bare text does not fit.
 */
export async function fitPayload(
  payload: MessagePayload,
  encrypt: (candidate: MessagePayload) => Promise<Sealed>,
  shrinkImage: (dataUrl: string) => Promise<string | undefined>,
): Promise<Fitted> {
  const trySeal = async (candidate: MessagePayload): Promise<Fitted | null> => {
    const sealed = await encrypt(candidate);
    return sealed.ciphertext.length <= LIMITS.MESSAGE_CIPHERTEXT_MAX ? { ...sealed, payload: candidate } : null;
  };

  const full = await trySeal(payload);
  if (full) return full;

  const previews = payload.linkPreviews ?? [];
  if (previews.length === 0) throw new Error(MESSAGE_TOO_LONG);

  const thumbs = await Promise.all(
    previews.map(async (p) => (p.image ? { ...p, image: await shrinkImage(p.image) } : p)),
  );
  const small = await trySeal(withPreviews(payload, thumbs));
  if (small) return small;

  const bare = await trySeal(withPreviews(payload, previews.map((p) => ({ ...p, image: undefined }))));
  if (bare) return bare;

  const textOnly = await trySeal(withPreviews(payload));
  if (textOnly) return textOnly;

  throw new Error(MESSAGE_TOO_LONG);
}
