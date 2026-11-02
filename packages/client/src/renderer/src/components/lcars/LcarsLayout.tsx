import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { useSession } from '../../state/session';
import StatusPicker from '../servers/StatusPicker';
import VoiceDock from '../voice/VoiceDock';
import './lcars.css';

/**
 * The LCARS layout's frame (see docs/SKINS.md, "LCARS"). TabsLayout hands it the same tab bar, panes, member list and
 * dialogs the tabs layout shows, so every feature works the same; only where things sit changes:
 *
 * - a sweep at the top left turns the thick left rail into the thin top bar, and another at the bottom left turns it
 *   into the bottom bar, so the frame is never the same thickness after a turn;
 * - the rail holds the tabs (Text, Voice, Watch together, Vault, Movies), then Server settings and Settings;
 * - the top bar holds Split, the window's drag area, the server's name, your status, and minimize, maximize and close;
 * - the bottom bar holds the call controls, or Join voice when you are not in the call.
 *
 * While this frame is on screen it is the window's title bar, so lcars.css hides the app's usual one.
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
  split: boolean;
  onToggleSplit: () => void;
  membersToggle: { hidden: boolean; toggle: () => void } | null;
  onOpenTest: () => void;
  onOpenServerSettings: (() => void) | null;
  onOpenSettings: () => void;
  onJoinVoice: (() => void) | null;
  windows: ReactNode;
}) {
  const user = useSession((s) => s.user);
  return (
    <div className="lcars-shell" data-region="shell" data-layout="lcars">
      <div className="lcars-rail" {...props.dropArea}>
        <span className="lcars-elbow top" aria-hidden="true" />
        {props.nav}
        <span className="lcars-rail-fill" aria-hidden="true" />
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
        <button type="button" className={`lcars-seg${props.split ? ' active' : ''}`} aria-pressed={props.split}
          title="Show the open tab beside the one before it (or Shift+click a tab; Shift+click a split tab to close it)"
          onClick={props.onToggleSplit}>
          <span className="lcars-label">Split</span>
        </button>
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
        <button type="button" className="lcars-seg" title="Feature test console (Ctrl+Shift+T)" aria-label="Feature test console" onClick={props.onOpenTest}>
          <span className="lcars-label">Test</span>
        </button>
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

/** Minimize, maximize and close as the last segments of the top bar. Without the desktop app's bridge there are none. */
function WindowButtons() {
  const controls = window.chatward?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls) return;
    const check = () => { void controls.isMaximized().then(setMaximized, () => {}); };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [controls]);
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
