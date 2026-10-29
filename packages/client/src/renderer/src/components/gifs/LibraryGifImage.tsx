import { useEffect, useRef, useState } from 'react';
import { libraryGifUrl } from '../../state/gifLibrary';

/**
 * A GIF from the server's library. The file needs the auth header, so it is fetched once it scrolls into view
 * and shown through an object URL. A GIF deleted from the library shows a small "GIF removed" box.
 */
export default function LibraryGifImage({ id, title, className }: { id: string; title: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [visible, setVisible] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const retried = useRef(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || visible) return;
    const win = el.ownerDocument.defaultView ?? window;
    if (!('IntersectionObserver' in win)) { setVisible(true); return; }
    const io = new win.IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setGone(false);
    libraryGifUrl(id).then((u) => { if (live) setSrc(u); }, () => { if (live) setGone(true); });
    return () => { live = false; };
  }, [id, visible]);

  if (gone) return <span className="muted media-gif-blocked gif-removed">GIF removed</span>;
  if (!src) return <span ref={boxRef} className={`gif-loading ${className ?? ''}`} aria-label={`Loading ${title || 'GIF'}`} />;
  // An object URL revoked after a delete fails to load; asking again finds out the GIF is gone.
  return <img className={className} src={src} alt={title || 'GIF'} onError={() => {
    if (retried.current) { setGone(true); return; }
    retried.current = true;
    setSrc(null);
    setVisible(false);
  }} />;
}
