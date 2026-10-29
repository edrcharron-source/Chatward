import { useEffect, useRef, useState } from 'react';

/** Open state for a popover anchored to a button. Closes on outside click and Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // the popover may sit in a popped-out window, so listen on the document it is drawn in
    const doc = ref.current?.ownerDocument ?? document;
    doc.addEventListener('mousedown', onPointerDown);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('mousedown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, setOpen, ref };
}
