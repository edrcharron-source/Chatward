import { useState, type FormEvent } from 'react';
import { LIMITS, type DeviceKeys, type User } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { accountKey, adoptLegacyDevice, getDevice, initDevice, legacyDevice } from '../../crypto';
import { enterDemo } from '../../demo';
import { useSession } from '../../state/session';
import './auth.css';

/** 'reset' sets a new password with a one-time code from the server owner. */
type Mode = 'login' | 'register' | 'reset';

export default function AuthScreen() {
  const savedUrl = useSession((s) => s.serverUrl);
  const [mode, setMode] = useState<Mode>('login');
  const [serverUrl, setServerUrlField] = useState(savedUrl);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const url = normalizeUrl(serverUrl);
    const name = username.trim();
    if (!url) { setError('Enter the server address.'); return; }
    if (name.length < LIMITS.USERNAME_MIN || name.length > LIMITS.USERNAME_MAX) {
      setError(`Username must be ${LIMITS.USERNAME_MIN}–${LIMITS.USERNAME_MAX} characters.`);
      return;
    }
    if (mode === 'register') {
      if (!displayName.trim()) { setError('Enter a display name.'); return; }
      if (password.length < LIMITS.PASSWORD_MIN) { setError(`Password must be at least ${LIMITS.PASSWORD_MIN} characters.`); return; }
    } else if (mode === 'reset') {
      if (!resetCode.trim()) { setError('Enter the reset code from the server owner.'); return; }
      if (password.length < LIMITS.PASSWORD_MIN) { setError(`New password must be at least ${LIMITS.PASSWORD_MIN} characters.`); return; }
    } else if (!password) {
      setError('Enter your password.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      useSession.getState().setServerUrl(url);
      // The page's connection rules name the server, so a different server needs a reload before anything can reach it.
      // The saved address comes back after the reload, so the user only re-enters the password.
      if (await window.chatward.server.allow(url)) { location.reload(); return; }
      await initDevice(accountKey(url, name));
      // Reset goes through the same device handling as login, so this PC's existing keys and history stay with the account.
      const send = (device: DeviceKeys) => {
        if (mode === 'reset') {
          return api.post<{ token: string; user: User }>('/api/auth/reset', { username: name, code: resetCode.trim(), newPassword: password, device });
        }
        return mode === 'login'
          ? api.post<{ token: string; user: User }>('/api/auth/login', { username: name, password, device })
          : api.post<{ token: string; user: User }>('/api/auth/register', {
              username: name,
              displayName: displayName.trim(),
              password,
              device,
              inviteCode: inviteCode.trim() || undefined,
            });
      };
      // An old PC device is only adopted once the server accepts it for this account. If another account owns it, the server refuses and this account keeps its own device.
      const legacy = await legacyDevice();
      let res: { token: string; user: User };
      let adopt = legacy !== null;
      try {
        res = await send(legacy ?? getDevice());
      } catch (err) {
        if (!legacy || !(err instanceof ApiError && err.message === 'device id is already registered')) throw err;
        adopt = false;
        res = await send(getDevice());
      }
      if (adopt) await adoptLegacyDevice();
      useSession.getState().setAuth(res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cw-auth">
      <form className="cw-auth-card card" onSubmit={submit}>
        <h1 className="cw-auth-title">Chatward</h1>

        {mode === 'reset' ? (
          <h2 className="cw-auth-subtitle">Reset password</h2>
        ) : (
          <div className="cw-auth-tabs" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'primary' : ''} onClick={() => { setMode('login'); setError(null); }}>Log in</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'primary' : ''} onClick={() => { setMode('register'); setError(null); }}>Register</button>
          </div>
        )}

        <label className="cw-field">
          <span>Server address</span>
          <input value={serverUrl} onChange={(e) => setServerUrlField(e.target.value)} placeholder="http://localhost:3000" autoComplete="url" spellCheck={false} required />
        </label>

        <label className="cw-field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} maxLength={LIMITS.USERNAME_MAX} required />
        </label>

        {mode === 'register' && (
          <label className="cw-field">
            <span>Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" maxLength={48} required />
          </label>
        )}

        {mode === 'reset' && (
          <label className="cw-field">
            <span>Reset code from the server owner</span>
            <input value={resetCode} onChange={(e) => setResetCode(e.target.value)} spellCheck={false} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" required />
          </label>
        )}

        <label className="cw-field">
          <span>{mode === 'reset' ? 'New password' : 'Password'}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
        </label>

        {mode === 'register' && (
          <label className="cw-field">
            <span>Invite code</span>
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} spellCheck={false} placeholder="Not needed for the first account" />
          </label>
        )}

        {error && <p className="cw-auth-error" role="alert">{error}</p>}

        <button type="submit" className="primary cw-auth-submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : mode === 'reset' ? 'Set new password' : 'Create account'}
        </button>
        {mode === 'login' && (
          <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => { setMode('reset'); setError(null); }}>
            Forgot password?
          </button>
        )}
        {mode === 'reset' && (
          <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => { setMode('login'); setError(null); }}>
            Back to log in
          </button>
        )}
        <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => void enterDemo()}>
          Try demo (offline, no server)
        </button>
      </form>
    </div>
  );
}

/** Trims, drops trailing slashes, and assumes http:// when no scheme is typed. */
function normalizeUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}
