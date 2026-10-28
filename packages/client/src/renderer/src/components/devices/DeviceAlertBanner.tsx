import { getDevice } from '../../crypto';
import { dismissDeviceAlert, useDeviceAlerts } from '../../state/deviceAlerts';
import '../updates/updates.css';

/** Strip at the top of the window: a new device signed in to this account. Shown until dismissed. */
export default function DeviceAlertBanner() {
  const alert = useDeviceAlerts((s) => s.alert);
  // This window's own sign-in is not news to it.
  if (!alert || alert.deviceId === getDevice().deviceId) return null;
  return (
    <div className="cw-update-bar cw-update-warn" role="alert">
      <span>
        A new device signed in to your account on {new Date(alert.createdAt).toLocaleString()}. If that wasn&apos;t you,
        remove it under Settings, Security, then change your password.
      </span>
      <button onClick={dismissDeviceAlert}>Got it</button>
    </div>
  );
}
