import { useState, type FormEvent } from 'react';
import { LIMITS, type User } from '@chatward/shared';
import { api } from '../../api/http';
import { deviceProof, getDevice } from '../../crypto';
import { useSession } from '../../state/session';
import { Section, errorText } from './controls';

interface Status { ok: boolean; text: string }

/** Changes the password. The server signs out every other session; this one gets a fresh token and stays signed in. */
export default function PasswordSection() {
  const setAuth = useSession((s) => s.setAuth);
  const user = useSession((s) => s.user);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  if (!user) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (next.length < LIMITS.PASSWORD_MIN) {
      setStatus({ ok: false, text: `The new password must be at least ${LIMITS.PASSWORD_MIN} characters.` });
      return;
    }
    if (next !== confirm) {
      setStatus({ ok: false, text: 'The new passwords do not match.' });
      return;
    }
    setBusy(true);
    try {
      // An account without a password sets its first one from this PC, so no current password is typed.
      const proof = user?.hasPassword === false ? { proof: await deviceProof() } : {};
      const res = await api.post<{ token: string; user: User }>('/api/me/password', { currentPassword: current, newPassword: next, deviceId: getDevice().deviceId, ...proof });
      setAuth(res.token, res.user);
      setCurrent('');
      setNext('');
      setConfirm('');
      setStatus({ ok: true, text: 'Password changed. You were signed out on your other devices.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Change password">
      <form onSubmit={save}>
        {user.hasPassword !== false && (
          <label className="field">
            <span>Current password</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
        )}
        <label className="field">
          <span>New password</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={LIMITS.PASSWORD_MIN} required />
        </label>
        <label className="field">
          <span>Repeat new password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={LIMITS.PASSWORD_MIN} required />
        </label>
        <p className="muted">Your chats and history are not tied to your password, so changing it loses nothing.</p>
        <button type="submit" className="primary" disabled={busy || (user.hasPassword !== false && !current) || !next || !confirm}>
          {user.hasPassword === false ? 'Set password' : 'Change password'}
        </button>
      </form>
      {status && <p className={status.ok ? 'ok-text' : 'error-text'} role="status">{status.text}</p>}
    </Section>
  );
}
