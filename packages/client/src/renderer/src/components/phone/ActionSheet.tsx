import type { ReactNode } from 'react';
import Sheet from './Sheet';

export interface Action { label: string; onPick: () => void; danger?: boolean }

/** The phone's long-press menu: the same items as the right-click menu, in a sheet from the bottom. */
export default function ActionSheet({ actions, onClose, preview }: { actions: Action[]; onClose: () => void; preview?: ReactNode }) {
  return (
    <Sheet onClose={onClose} label="Message options">
      {preview && <div className="cw-action-preview">{preview}</div>}
      <div className="media-menu cw-action-list" role="menu" aria-label="Message options">
        {actions.map((a) => (
          <button key={a.label} type="button" role="menuitem" className={a.danger ? 'cv-msg-menu-danger' : undefined}
            onClick={() => { onClose(); a.onPick(); }}>
            {a.label}
          </button>
        ))}
      </div>
      <button type="button" className="cw-action-cancel" onClick={onClose}>Cancel</button>
    </Sheet>
  );
}
