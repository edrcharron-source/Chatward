import type { ReactNode } from 'react';
import Sheet from './Sheet';

export interface Action { label: string; onPick: () => void; danger?: boolean }

/** The phone's long-press menu: a list of actions sliding up from the bottom, with Cancel under it. */
export default function ActionSheet({ actions, onClose, preview }: { actions: Action[]; onClose: () => void; preview?: ReactNode }) {
  return (
    <Sheet onClose={onClose} className="cw-action-sheet">
      {preview && <div className="cw-action-preview">{preview}</div>}
      <div className="cw-row-group">
        {actions.map((a) => (
          <button key={a.label} type="button" className={`cw-row cw-action${a.danger ? ' cw-row-danger' : ''}`}
            onClick={() => { onClose(); a.onPick(); }}>
            <span className="cw-row-label">{a.label}</span>
          </button>
        ))}
      </div>
      <div className="cw-row-group">
        <button type="button" className="cw-row cw-action cw-action-cancel" onClick={onClose}><span className="cw-row-label">Cancel</span></button>
      </div>
    </Sheet>
  );
}
