import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { useSession } from '../../state/session';
import { ResizeEdges, useMaximized, useShapedWindow } from '../titlebar/windowShape';
import StatusPicker from '../servers/StatusPicker';
import VoiceDock from '../voice/VoiceDock';
import { isLebserver } from '../brand/PoweredBy';
import './lcars.css';
import MysteryButton from '../mystery/MysteryButton';

/**
 * The LCARS layout's frame (see docs/SKINS.md, "LCARS"). TabsLayout hands it the same tab bar, panes, member list and
 * dialogs the tabs layout shows, so every feature works the same; only where things sit changes:
 *
 * - a sweep at the top left turns the thick left rail into the thin top bar, and another at the bottom left turns it
 *   into the bottom bar, so the frame is never the same thickness after a turn;
 * - the rail holds the tabs (Text, Voice, Watch together, Vault, Movies), then Server settings and Settings;
 * - the top bar holds the window's drag area, the server's name, your status, and minimize, maximize and close;
 * - the bottom bar holds the call controls, or Join voice when you are not in the call.
 *
 * While this frame is on screen it is the window's title bar, so lcars.css hides the app's usual one. The desktop app
 * gives this layout a transparent window with no border or shadow (components/lcars/shapedWindow.ts), and the page
 * paints nothing past the frame's outline (round at the two sweeps and at the end caps on the right), so no window
 * corner or edge shows past it. The "powered by" strip moves into the rail for the same reason.
 */
export default function LcarsLayout(props: {
  serverName: string;
  nav: ReactNode;
  dropArea: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  main: ReactNode;
  members: ReactNode;
  membersToggle: { hidden: boolean; toggle: () => void } | null;
  onOpenServerSettings: (() => void) | null;
  onOpenSettings: () => void;
  onJoinVoice: (() => void) | null;
  windows: ReactNode;
}) {
  const user = useSession((s) => s.user);
  const lebserver = useSession((s) => isLebserver(s.serverUrl));
  const shell = useRef<HTMLDivElement>(null);
  const shaped = useShapedFrame(shell);
  return (
    <div className="lcars-shell" data-region="shell" data-layout="lcars" data-shaped={shaped ? '' : undefined} ref={shell}>
      {shaped && <ResizeEdges className="lcars-resize" />}
      <div className="lcars-rail" {...props.dropArea}>
        <span className="lcars-elbow top" aria-hidden="true" />
        {props.nav}
        <span className="lcars-rail-fill">
          {lebserver && <span className="lcars-powered" aria-label="Powered by Lebserver">Powered by Lebserver</span>}
        </span>
        {props.onOpenServerSettings && (
          <button type="button" className="lcars-seg lcars-rail-seg" title="Server settings" onClick={props.onOpenServerSettings}>
            <span className="lcars-label">Server settings</span>
          </button>
        )}
        <button type="button" className="lcars-seg lcars-rail-seg" title="Settings" aria-label="Settings" onClick={props.onOpenSettings}>
          <span className="lcars-label">Settings</span>
        </button>
        <span className="lcars-elbow bottom" aria-hidden="true" />
      </div>

      <header className="lcars-top" data-region="tabs">
        <span className="lcars-arm" aria-hidden="true" />
        {props.membersToggle && (
          <button type="button" className="lcars-seg" aria-pressed={props.membersToggle.hidden} onClick={props.membersToggle.toggle}>
            <span className="lcars-label">{props.membersToggle.hidden ? 'Show members' : 'Hide members'}</span>
          </button>
        )}
        <span className="lcars-drag" aria-hidden="true" />
        <strong className="lcars-title">{props.serverName}</strong>
        <span className="lcars-seg lcars-me">
          <span className="lcars-me-name">{user?.displayName ?? ''}</span>
          <StatusPicker />
        </span>
        <MysteryButton className="lcars-seg"><span className="lcars-label">Mystery</span></MysteryButton>
        <WindowButtons />
      </header>

      <div className="lcars-body">
        {props.main}
        {props.members && <div className="lcars-members" data-region="side">{props.members}</div>}
      </div>

      <footer className="lcars-bottom" aria-label="Call controls">
        <VoiceDock bar={{ onJoin: props.onJoinVoice }} />
      </footer>

      {props.windows}
    </div>
  );
}

/**
 * In the shaped window (transparent, no border) the page's own background must not show past the frame: the page
 * behind the frame is cleared (lcars.css, html.cw-shaped-lcars) and the page is clipped to the frame's outline, so a
 * dialog's dimmed backdrop doesn't paint the see-through corners either. Maximized, the window fills the screen and stays
 * a plain rectangle. Returns true while the frame is shaped, so the edges can resize the window.
 */
function useShapedFrame(shell: RefObject<HTMLDivElement | null>): boolean {
  const shapedWindow = useShapedWindow();
  const maximized = useMaximized();
  const shaped = shapedWindow && !maximized;
  useEffect(() => {
    const el = shell.current;
    if (!shapedWindow || !el) return;
    const root = document.documentElement;
    root.classList.add('cw-shaped-lcars');
    if (maximized) return () => root.classList.remove('cw-shaped-lcars');
    const css = getComputedStyle(el);
    const px = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
    const fit = () => {
      // The frame has been drawn at the window's current size: tell the main process it may take the next resize step.
      requestAnimationFrame(() => window.chatward?.windowControls?.ackResize?.());
      // A strip above the frame (the demo banner) holds the window's top edge, so the top corners stay square then;
      // the frame's own sweep still shows the desktop past its curve, as the ground behind it is clear.
      const top = el.getBoundingClientRect().top > 0.5 ? 0 : 1;
      // Corners in clip-path order: top left, top right, bottom right, bottom left.
      document.body.style.clipPath =
        `inset(0 round ${top * px('--lc-outer')}px ${top * px('--lc-top') / 2}px ${px('--lc-bottom') / 2}px ${px('--lc-outer')}px)`;
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => { watch.disconnect(); root.classList.remove('cw-shaped-lcars'); document.body.style.clipPath = ''; };
  }, [shell, shapedWindow, maximized]);
  return shaped;
}

/** Minimize, maximize and close as the last segments of the top bar. Without the desktop app's bridge there are none. */
function WindowButtons() {
  const controls = window.chatward?.windowControls;
  const maximized = useMaximized();
  // macOS draws its own window buttons, so the bar ends in a plain cap there.
  if (!controls || controls.platform === 'darwin') return <span className="lcars-seg lcars-end" aria-hidden="true" />;
  return (
    <>
      <button type="button" className="lcars-seg lcars-win" aria-label="Minimize" title="Minimize" tabIndex={-1}
        onClick={() => controls.minimize()}>
        <span className="lcars-label">Min</span>
      </button>
      <button type="button" className="lcars-seg lcars-win" aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} tabIndex={-1}
        onClick={() => controls.toggleMaximize()}>
        <span className="lcars-label">{maximized ? 'Restore' : 'Max'}</span>
      </button>
      <button type="button" className="lcars-seg lcars-win danger lcars-end" aria-label="Close" title="Close" tabIndex={-1}
        onClick={() => controls.close()}>
        <span className="lcars-label">Close</span>
      </button>
    </>
  );
}
