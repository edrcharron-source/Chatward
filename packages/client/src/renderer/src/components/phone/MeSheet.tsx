import { sendFrame } from '../../api/ws';
import { useSession } from '../../state/session';
import Avatar from '../servers/Avatar';
import PixelIcon from '../icons/PixelIcon';
import PoweredBy from '../brand/PoweredBy';
import Sheet, { SheetRow } from './Sheet';
import { PushPanel } from './Notifications';

type Status = ReturnType<typeof useSession.getState>['myStatus'];
const STATUSES: Array<{ id: Status; label: string }> = [
  { id: 'online', label: 'Online' },
  { id: 'idle', label: 'Idle' },
  { id: 'dnd', label: 'Do not disturb' },
];

/** The phone's "You" sheet: your name and status, notifications, and the way into Settings and Server settings. */
export default function MeSheet({ onClose, onOpenSettings, onOpenServerSettings }: {
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenServerSettings: (() => void) | null;
}) {
  const user = useSession((s) => s.user);
  const myStatus = useSession((s) => s.myStatus);
  const setMyStatus = useSession((s) => s.setMyStatus);
  const pick = (status: Status) => { setMyStatus(status); sendFrame({ t: 'presence', status }); };
  const then = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <Sheet title="You" onClose={onClose} className="cw-me-sheet">
      <div className="cw-me-card">
        {user && (
          <span className="cw-avatar-wrap">
            <Avatar user={user} size={52} />
            <span className={`cw-dot ${myStatus}`} aria-hidden="true" />
          </span>
        )}
        <div className="cw-me-who">
          <strong>{user?.displayName ?? ''}</strong>
          <span className="muted">@{user?.username ?? ''}</span>
        </div>
      </div>
      <div className="cw-segment" role="radiogroup" aria-label="Your status">
        {STATUSES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={myStatus === s.id}
            className={myStatus === s.id ? 'on' : undefined} onClick={() => pick(s.id)}>
            <span className={`cw-dot-inline ${s.id}`} aria-hidden="true" />{s.label}
          </button>
        ))}
      </div>
      <PushPanel />
      <div className="cw-row-group">
        <SheetRow icon={<PixelIcon name="gear" size={18} />} label="Settings" onClick={then(onOpenSettings)} />
        {onOpenServerSettings && <SheetRow icon={<PixelIcon name="shield" size={18} />} label="Server settings" onClick={then(onOpenServerSettings)} />}
      </div>
      <div className="cw-me-brand"><PoweredBy force /></div>
    </Sheet>
  );
}
