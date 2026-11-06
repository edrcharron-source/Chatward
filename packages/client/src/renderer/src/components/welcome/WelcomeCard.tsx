import { useSettings } from '../../state/settings';
import { usePhone } from '../../web/usePhone';
import './welcome.css';

const WEB = !!__CHATWARD_BUILD__.web;

/** The web app running from the home screen, not a Safari tab. */
function installed(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * A short welcome above the chat for someone new: what each tab is for, and buttons for the first things people do.
 * It stays until they press Got it (saved on this device only).
 */
export default function WelcomeCard({ serverName, onJoinVoice, onOpenNotifications, onInvite }: {
  serverName: string;
  onJoinVoice?: () => void;
  /** opens Settings on the Notifications tab */
  onOpenNotifications: () => void;
  /** set for the owner and admins: opens server settings, where sign-up codes are made */
  onInvite?: () => void;
}) {
  const dismissed = useSettings((s) => s.welcomeDismissed);
  const phone = usePhone();
  const set = useSettings((s) => s.set);
  if (dismissed) return null;
  return (
    <section className="cw-welcome" aria-label="Welcome">
      <div className="cw-welcome-text">
        <strong>Welcome to {serverName}</strong>
        <p className="cw-welcome-about">
          Chat here, talk in <b>Voice</b>, watch videos together in <b>Watch</b>, keep photos in the <b>Vault</b> and
          log workouts in <b>Workouts</b>. Messages, photos and calls are end-to-end encrypted.
        </p>
        {WEB && phone && !installed() && (
          <p className="cw-welcome-tip">On iPhone, tap Share, then Add to Home Screen, to use Chatward like an app and get notifications.</p>
        )}
      </div>
      <div className="cw-welcome-actions">
        {onJoinVoice && <button type="button" className="primary" onClick={onJoinVoice}>Join voice</button>}
        {onInvite && <button type="button" onClick={onInvite}>Invite a friend</button>}
        <button type="button" onClick={onOpenNotifications}>Set up notifications</button>
        <button type="button" className="cw-welcome-done" onClick={() => set({ welcomeDismissed: true })}>Got it</button>
      </div>
    </section>
  );
}
