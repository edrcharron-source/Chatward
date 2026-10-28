import { useState, type FormEvent } from 'react';
import { LIMITS, type DeviceKeys, type User } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { accountKey, adoptLegacyDevice, getDevice, initDevice, legacyDevice } from '../../crypto';
import { enterDemo } from '../../demo';
import { useSession } from '../../state/session';
import './auth.css';

type Mode = 'login' | 'register';

export default function AuthScreen() {
  const savedUrl = useSession((s) => s.serverUrl);
  const [mode, setMode] = useState<Mode>('login');
  const [serverUrl, setServerUrlField] = useState(savedUrl);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
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
    } else if (!password) {
      setError('Enter your password.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      useSession.getState().setServerUrl(url);
      await initDevice(accountKey(url, name));
      const send = (device: DeviceKeys) => mode === 'login'
        ? api.post<{ token: string; user: User }>('/api/auth/login', { username: name, password, device })
        : api.post<{ token: string; user: User }>('/api/auth/register', {
            username: name,
            displayName: displayName.trim(),
            password,
            device,
            inviteCode: inviteCode.trim() || undefined,
          });
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

        <div className="cw-auth-tabs" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'primary' : ''} onClick={() => { setMode('login'); setError(null); }}>Log in</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'primary' : ''} onClick={() => { setMode('register'); setError(null); }}>Register</button>
        </div>

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

        <label className="cw-field">
          <span>Password</span>
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
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
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
