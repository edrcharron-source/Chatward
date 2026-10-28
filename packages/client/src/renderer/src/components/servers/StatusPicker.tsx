import { sendFrame } from '../../api/ws';
import { useSession } from '../../state/session';

type Status = ReturnType<typeof useSession.getState>['myStatus'];

const LABELS: Record<Status, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
};

/** Lets the user pick Online, Idle or Do Not Disturb. The server shows that status to everyone who shares a server with them. */
export default function StatusPicker() {
  const myStatus = useSession((s) => s.myStatus);
  const setMyStatus = useSession((s) => s.setMyStatus);

  function pick(status: Status) {
    setMyStatus(status);
    sendFrame({ t: 'presence', status });
  }

  return (
    <select
      className="cw-status-select"
      value={myStatus}
      aria-label="Your status"
      title="Your status"
      onChange={(e) => pick(e.target.value as Status)}
    >
      {(Object.keys(LABELS) as Status[]).map((s) => (
        <option key={s} value={s}>{LABELS[s]}</option>
      ))}
    </select>
  );
}
