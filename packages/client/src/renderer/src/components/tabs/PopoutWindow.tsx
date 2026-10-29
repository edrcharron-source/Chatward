import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A popped-out tab is a second window of this app that this window draws into. It runs no code of its own: the tab's
// components stay in this window's React tree and keep using its session, keys, socket and call, so nothing has to be
// signed in twice. The window gets copies of this window's stylesheets, theme and skin, kept current.

const openWindows = new Set<Window>();

/** True while one of the popped-out windows has focus, so a chat shown there counts as being looked at. */
export function popoutHasFocus(): boolean {
  return [...openWindows].some((w) => !w.closed && w.document.hasFocus());
}

const COPIED = 'data-cw-copied';

function copyStyles(from: Document, to: Document) {
  to.head.querySelectorAll(`[${COPIED}]`).forEach((n) => n.remove());
  from.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = to.importNode(node, true) as HTMLElement;
    // about:blank resolves relative links against a different base, so give each stylesheet its full address
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    copy.setAttribute(COPIED, '');
    to.head.appendChild(copy);
  });
}

function copyRootAttributes(from: Document, to: Document) {
  for (const name of ['data-theme', 'data-skin']) {
    const value = from.documentElement.getAttribute(name);
    if (value === null) to.documentElement.removeAttribute(name);
    else to.documentElement.setAttribute(name, value);
  }
}

/** Draws `children` in their own window while mounted. `onClose` runs when the user closes that window. */
export function PopoutWindow({ id, title, onClose, children }: {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // The main process only lets windows with this name prefix open (src/main/index.ts).
    const win = window.open('about:blank', `chatward-tab-${id}`, 'width=1000,height=700');
    if (!win) {
      onCloseRef.current();
      return;
    }
    const doc = win.document;
    doc.title = title;
    copyStyles(document, doc);
    copyRootAttributes(document, doc);
    const styleWatch = new MutationObserver(() => copyStyles(document, doc));
    styleWatch.observe(document.head, { childList: true });
    const rootWatch = new MutationObserver(() => copyRootAttributes(document, doc));
    rootWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] });

    doc.body.replaceChildren();
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);
    openWindows.add(win);
    setContainer(root);

    let done = false;
    const closed = () => {
      if (done) return;
      done = true;
      onCloseRef.current();
    };
    win.addEventListener('pagehide', closed);
    // pagehide does not always reach us from a window the user closes, so check now and then as well
    const poll = setInterval(() => { if (win.closed) closed(); }, 1000);
    const closeWithUs = () => win.close();
    window.addEventListener('pagehide', closeWithUs);

    return () => {
      done = true;
      clearInterval(poll);
      styleWatch.disconnect();
      rootWatch.disconnect();
      win.removeEventListener('pagehide', closed);
      window.removeEventListener('pagehide', closeWithUs);
      openWindows.delete(win);
      setContainer(null);
      if (!win.closed) win.close();
    };
  }, [id]);

  return container ? createPortal(<div className="cw-popout">{children}</div>, container) : null;
}
