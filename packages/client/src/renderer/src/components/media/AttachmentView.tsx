import { useEffect, useState, type ReactElement } from 'react';
import type { Attachment } from '@chatward/shared';
import { api } from '../../api/http';
import { decryptBlob } from '../../crypto';
import { INLINE_IMAGE_MIMES } from './upload';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetches the encrypted blob and decrypts it in memory. Returns an object URL, or null while loading/failed. */
function useDecryptedUrl(attachment: Attachment): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setState({ url: null, failed: false });
    (async () => {
      try {
        const buf = await api.getBytes(`/api/uploads/${attachment.uploadId}`);
        const plain = await decryptBlob(new Uint8Array(buf), attachment.key, attachment.iv);
        // Crypto always allocates a plain ArrayBuffer; the narrower type is what Blob requires.
        objectUrl = URL.createObjectURL(new Blob([plain as Uint8Array<ArrayBuffer>], { type: attachment.mime }));
        if (alive) setState({ url: objectUrl, failed: false });
      } catch {
        if (alive) setState({ url: null, failed: true });
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.uploadId, attachment.key, attachment.iv, attachment.mime]);

  return state;
}

export function AttachmentView({ attachment }: { attachment: Attachment }): ReactElement | null {
  const { url, failed } = useDecryptedUrl(attachment);
  const [enlarged, setEnlarged] = useState(false);
  const isImage = INLINE_IMAGE_MIMES.has(attachment.mime);

  useEffect(() => {
    if (!enlarged) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnlarged(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enlarged]);

  if (failed) {
    return <p className="media-error">Couldn't load “{attachment.name}”.</p>;
  }

  if (!isImage) {
    return (
      <div className="media-file">
        <span className="media-file-name" title={attachment.name}>{attachment.name}</span>
        <span className="muted">{formatSize(attachment.size)}</span>
        {url ? (
          <a className="media-file-download" href={url} download={attachment.name}>
            Download
          </a>
        ) : (
          <span className="muted">Decrypting…</span>
        )}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className="media-image-placeholder"
        style={attachment.width && attachment.height ? { aspectRatio: `${attachment.width} / ${attachment.height}` } : undefined}
        aria-label={`Loading ${attachment.name}`}
      />
    );
  }

  return (
    <>
      <button type="button" className="media-open" onClick={() => setEnlarged(true)} aria-label={`View ${attachment.name} full size`}>
        <img
          className="media-image"
          src={url}
          alt={attachment.name}
          width={attachment.width}
          height={attachment.height}
        />
      </button>
      {enlarged && (
        <div className="modal-backdrop media-lightbox" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={() => setEnlarged(false)}>
          <img className="media-lightbox-img" src={url} alt={attachment.name} onClick={(e) => e.stopPropagation()} />
          <button type="button" className="media-lightbox-close" autoFocus onClick={() => setEnlarged(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
