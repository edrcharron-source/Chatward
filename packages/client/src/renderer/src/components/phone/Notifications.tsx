import { useCallback, useEffect, useState } from 'react';
import { disablePush, enablePush, pushState, testPush, type PushState } from '../../web/push';

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

/** Notifications on/off for this phone, drawn as a Settings section (setting-section / setting-row). */
export function PushPanel() {
  const { state, msg, busy, enable, disable, test } = usePush();
  if (!state || state === 'unsupported') return null;
  return (
    <section className="setting-section" aria-label="Notifications">
      <h3>Notifications</h3>
      <div className="setting-row cw-push-row">
        <span className="setting-text">
          <span>{state === 'on' ? 'On for this phone' : state === 'off' ? 'Off on this phone' : state === 'denied' ? 'Blocked' : 'Not available yet'}</span>
          <small className="muted">
            {state === 'on' && 'New messages, nudges and cheers buzz this phone while Chatward is closed.'}
            {state === 'off' && 'Get a buzz for new messages, nudges and cheers.'}
            {state === 'denied' && "Allow them for Chatward in your iPhone's Settings, under Notifications."}
            {state === 'needs-install' && 'Add Chatward to your Home Screen first (Share, then Add to Home Screen) and open it from there.'}
          </small>
        </span>
        {state === 'off' && <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>Turn on</button>}
      </div>
      {state === 'on' && (
        <div className="row-actions">
          <button type="button" onClick={test}>Send a test</button>
          <button type="button" disabled={busy} onClick={() => void disable()}>Turn off</button>
        </div>
      )}
      {msg && <p className="muted small" role="status">{msg}</p>}
    </section>
  );
}

/**
 * A card above the chat on a phone that hasn't turned notifications on yet, in the welcome card's style. One tap asks
 * for permission. It can be dismissed; the switch is always in the "You" sheet too.
 */
export function NotifyPrompt() {
  const { state, msg, busy, enable } = usePush();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
  if (dismissed || (state !== 'off' && state !== 'needs-install' && !msg)) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } };
  return (
    <section className="cw-welcome cw-notify-prompt" aria-label="Notifications">
      <div className="cw-welcome-text">
        <strong>Notifications</strong>
        <p>{msg ?? (state === 'off' ? 'Get a buzz on this phone for new messages.' : 'Add Chatward to your Home Screen (Share, then Add to Home Screen) to get notifications.')}</p>
      </div>
      <div className="cw-welcome-actions">
        {state === 'off' && <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>Turn on</button>}
        <button type="button" className="cw-welcome-done" onClick={dismiss}>Not now</button>
      </div>
    </section>
  );
}
