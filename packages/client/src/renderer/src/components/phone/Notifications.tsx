import { useCallback, useEffect, useState } from 'react';
import { disablePush, enablePush, pushState, testPush, type PushState } from '../../web/push';
import PixelIcon from '../icons/PixelIcon';

const DISMISS_KEY = 'chatward.notifyPromptDismissed';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** This device's notification state, and actions that update it. null while it is being checked. */
export function usePush() {
  const [state, setState] = useState<PushState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => { void pushState().then(setState, () => setState('unsupported')); }, []);
  useEffect(() => {
    refresh();
    // Coming back from the iPhone Settings app (where notifications may have been allowed) re-checks.
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  const run = async (fn: () => Promise<PushState>) => {
    setMsg(null); setBusy(true);
    try { setState(await fn()); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };
  return {
    state, msg, busy,
    // These must run straight from a tap: iPhone only shows the permission question in answer to one.
    enable: () => run(enablePush),
    disable: () => run(disablePush),
    test: () => { setMsg(null); void testPush().then((r) => setMsg(r.delivered ? 'Test sent. It should show in a moment.' : 'The test could not be delivered.'), (e) => setMsg(errText(e))); },
  };
}

/** Notifications on/off for this phone, for the "You" sheet. */
export function PushPanel() {
  const { state, msg, busy, enable, disable, test } = usePush();
  if (!state || state === 'unsupported') return null;
  return (
    <section className="cw-push-panel" aria-label="Notifications">
      <div className="cw-push-head">
        <span className="cw-row-icon" aria-hidden="true"><PixelIcon name="bell" size={18} /></span>
        <div className="cw-push-text">
          <strong>Notifications</strong>
          <span className="muted">
            {state === 'on' && 'On for this phone.'}
            {state === 'off' && 'Get a buzz for new messages, nudges and cheers.'}
            {state === 'denied' && "Blocked. Allow them for Chatward in your iPhone's Settings, under Notifications."}
            {state === 'needs-install' && 'Add Chatward to your Home Screen first: tap Share, then Add to Home Screen, and open it from there.'}
          </span>
        </div>
      </div>
      {state === 'off' && <button type="button" className="primary cw-push-btn" disabled={busy} onClick={() => void enable()}>Turn on notifications</button>}
      {state === 'on' && (
        <div className="cw-push-actions">
          <button type="button" onClick={test}>Send a test</button>
          <button type="button" disabled={busy} onClick={() => void disable()}>Turn off</button>
        </div>
      )}
      {msg && <p className="muted cw-push-msg" role="status">{msg}</p>}
    </section>
  );
}

/**
 * A slim banner above the chat on a phone that hasn't turned notifications on yet. One tap asks for permission. It can
 * be dismissed; the switch is always in the "You" sheet too.
 */
export function NotifyPrompt() {
  const { state, msg, busy, enable } = usePush();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
  if (dismissed || (state !== 'off' && state !== 'needs-install' && !msg)) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } };
  return (
    <div className="cw-notify-prompt" role="region" aria-label="Notifications">
      <PixelIcon name="bell" size={16} />
      <span className="cw-notify-text">
        {msg ?? (state === 'off' ? 'Get notified about new messages.' : 'Add to Home Screen to get notifications.')}
      </span>
      {state === 'off' && <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>Turn on</button>}
      <button type="button" className="icon cw-notify-x" aria-label="Dismiss" onClick={dismiss}>✕</button>
    </div>
  );
}
