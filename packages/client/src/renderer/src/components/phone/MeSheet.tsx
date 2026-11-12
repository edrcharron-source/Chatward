import { useSession } from '../../state/session';
import Avatar from '../servers/Avatar';
import StatusPicker from '../servers/StatusPicker';
import PixelIcon from '../icons/PixelIcon';
import PoweredBy from '../brand/PoweredBy';
import Sheet from './Sheet';
import { PushPanel } from './Notifications';

/**
 * The phone's "You" sheet, behind the gear in the top bar. It holds what sits in the bottom corner of the wide layout
 * (your card and status) plus notifications, and the Settings and Server settings buttons the wide layout's bar has.
 */
export default function MeSheet({ onClose, onOpenSettings, onOpenServerSettings }: {
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenServerSettings: (() => void) | null;
}) {
  const user = useSession((s) => s.user);
  const myStatus = useSession((s) => s.myStatus);
  const then = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <Sheet title="You" onClose={onClose}>
      <section className="cw-me" aria-label="You">
        <div className="cw-me-head">
          {user && (
            <span className="cw-avatar-wrap">
              <Avatar user={user} size={32} />
              <span className={`cw-dot ${myStatus}`} aria-hidden="true" />
            </span>
          )}
          <strong className="cw-me-name">{user?.displayName ?? ''}</strong>
          <StatusPicker />
        </div>
      </section>
      <PushPanel />
      <div className="cw-sheet-actions">
        <button type="button" className="cw-tool" onClick={then(onOpenSettings)}><PixelIcon name="gear" size={14} /><span>Settings</span></button>
        {onOpenServerSettings && <button type="button" className="cw-tool" onClick={then(onOpenServerSettings)}><PixelIcon name="shield" size={14} /><span>Server settings</span></button>}
      </div>
      <div className="cw-me-brand"><PoweredBy force /></div>
    </Sheet>
  );
}
