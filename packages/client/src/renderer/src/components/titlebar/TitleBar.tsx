import { useEffect, useRef, useState } from 'react';
import './titlebar.css';

// The app's own title bar. Windows open without the system frame (src/main/index.ts), so this bar is the drag area and
// holds minimize, maximize and close. It draws into whichever window it sits in: the main window, or a popped-out tab
// that this window's page draws into, which it names by the window's name.
//
// Skins restyle it like everything else: the --titlebar-* tokens in styles/theme.css and the class names below
// (cw-titlebar, cw-titlebar-title, cw-titlebar-button, and min, max, close on the buttons). See docs/SKINS.md.

// 10 x 10 glyphs on whole pixels, drawn with the current text colour.
const GLYPHS = {
  min: <path d="M0 5h10v1H0z" />,
  max: <path d="M0 0h10v10H0zM1 1v8h8V1z" fillRule="evenodd" />,
  restore: <path d="M2 0h8v8H8V1H2zM0 2h8v8H0zM1 3v6h6V3z" fillRule="evenodd" />,
  close: <path d="M0 0h1.4L5 3.6 8.6 0H10v1.4L6.4 5 10 8.6V10H8.6L5 6.4 1.4 10H0V8.6L3.6 5 0 1.4z" />,
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return <svg className="cw-titlebar-glyph" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" shapeRendering="crispEdges">{GLYPHS[name]}</svg>;
}

export function TitleBar({ title = 'Chatward' }: { title?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [maximized, setMaximized] = useState(false);
  const controls = window.chatward?.windowControls;

  // The window this bar is drawn in. A pop-out's bar is rendered by this page into the pop-out's document.
  useEffect(() => {
    const view = ref.current?.ownerDocument.defaultView;
    if (!view || !controls) return;
    const name = view === window ? undefined : view.name;
    setTarget(name);
    const check = () => { void controls.isMaximized(name).then(setMaximized, () => {}); };
    check();
    view.addEventListener('resize', check);
    return () => view.removeEventListener('resize', check);
  }, [controls]);

  // Without the desktop app's bridge (tests in Node) there is no frame to replace.
  if (!controls) return null;
  // macOS keeps its own traffic lights at the left, so the bar only makes room for them.
  const mac = controls.platform === 'darwin';
  return (
    // Dragging, double-click to maximize and Windows snap come from the system, through -webkit-app-region in the CSS.
    <header ref={ref} className={`cw-titlebar${mac ? ' mac' : ''}`} data-region="titlebar">
      <div className="cw-titlebar-drag">
        <span className="cw-titlebar-mark" aria-hidden="true" />
        <span className="cw-titlebar-title">{title}</span>
      </div>
      {!mac && (
        <div className="cw-titlebar-buttons">
          <button type="button" className="cw-titlebar-button min" aria-label="Minimize" title="Minimize" tabIndex={-1}
            onClick={() => controls.minimize(target)}><Glyph name="min" /></button>
          <button type="button" className="cw-titlebar-button max" aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} tabIndex={-1}
            onClick={() => controls.toggleMaximize(target)}><Glyph name={maximized ? 'restore' : 'max'} /></button>
          <button type="button" className="cw-titlebar-button close" aria-label="Close" title="Close" tabIndex={-1}
            onClick={() => controls.close(target)}><Glyph name="close" /></button>
        </div>
      )}
    </header>
  );
}
