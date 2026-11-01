import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './confirm.css';

// An in-app yes/no question, drawn in the app's own look (so it follows the active skin) instead of the system box.
// The provider nearest to a component decides where the dialog appears: the main window has one at the root, and a
// popped-out tab has its own, drawn into that window. So a delete asked from a popped-out text window shows there.

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** When set, a checkbox with this label is shown and its state is returned. */
  checkboxLabel?: string;
}

export interface ConfirmResult {
  ok: boolean;
  checked: boolean;
}

type Ask = (opts: ConfirmOptions) => Promise<ConfirmResult>;
type Pending = { opts: ConfirmOptions; resolve: (r: ConfirmResult) => void };

const CANCELLED: ConfirmResult = { ok: false, checked: false };
const ConfirmContext = createContext<Ask | null>(null);

/**
 * Lets descendants ask a yes/no question. `container` is the element the dialog is drawn into; leave it out for the
 * main window (document.body). Pass the popped-out window's root when wrapping that window's tree.
 */
export function ConfirmProvider({ container, children }: { container?: HTMLElement | null; children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const ask = useCallback<Ask>((opts) => new Promise<ConfirmResult>((resolve) => {
    // A new question replaces one still on screen; that one counts as cancelled so its caller does nothing.
    pendingRef.current?.resolve(CANCELLED);
    const next = { opts, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  const finish = (r: ConfirmResult) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(r);
  };

  const target = container === undefined ? document.body : container;
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && target && createPortal(<ConfirmView opts={pending.opts} onDone={finish} />, target)}
    </ConfirmContext.Provider>
  );
}

/** Returns the `ask` function of the nearest ConfirmProvider. */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm needs a ConfirmProvider above it');
  return ask;
}

function ConfirmView({ opts, onDone }: { opts: ConfirmOptions; onDone: (r: ConfirmResult) => void }) {
  const [checked, setChecked] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  const finish = (ok: boolean) => onDone({ ok, checked: ok && checked });

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') finish(false); }}
    >
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{opts.title}</h2>
        <p id="confirm-message">{opts.message}</p>
        {opts.checkboxLabel && (
          <label className="confirm-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{opts.checkboxLabel}</span>
          </label>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className={opts.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>
            {opts.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
