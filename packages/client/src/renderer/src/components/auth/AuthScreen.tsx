import { useState, type FormEvent } from 'react';
import { LIMITS, type DeviceKeys, type User } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { accountKey, adoptLegacyDevice, deviceProof, getDevice, initDevice, legacyDevice } from '../../crypto';
import { buildLabel } from '../../buildInfo';
import { enterDemo } from '../../demo';
import { useSession } from '../../state/session';
import './auth.css';

/** 'register' needs a one-time sign-up code from `chatward invite`; 'reset' sets a new password with a code from the owner. */
type Mode = 'login' | 'register' | 'reset';

export default function AuthScreen() {
  const savedUrl = useSession((s) => s.serverUrl);
  const [mode, setMode] = useState<Mode>('login');
  const [serverUrl, setServerUrlField] = useState(savedUrl);
  // The address is filled in for most people, so it hides behind "Change" until someone needs it.
  const [editServer, setEditServer] = useState(!savedUrl);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signupCode, setSignupCode] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const url = normalizeUrl(serverUrl);
    const trimmed = name.trim();
    if (!url) { setEditServer(true); setError('Enter the server address.'); return; }
    if (trimmed.length < LIMITS.USERNAME_MIN || trimmed.length > LIMITS.USERNAME_MAX) {
      setError(`Your name is ${LIMITS.USERNAME_MIN}–${LIMITS.USERNAME_MAX} characters.`);
      return;
    }
    if (mode === 'register') {
      if (!signupCode.trim()) { setError('Enter the sign-up code you were sent.'); return; }
    } else if (mode === 'reset') {
      if (!resetCode.trim()) { setError('Enter the reset code from the server owner.'); return; }
      if (password.length < LIMITS.PASSWORD_MIN) { setError(`New password must be at least ${LIMITS.PASSWORD_MIN} characters.`); return; }
    }

    setBusy(true);
    setError(null);
    try {
      useSession.getState().setServerUrl(url);
      // The page's connection rules name the server, so a different server needs a reload before anything can reach it.
      // The saved address comes back after the reload, so the user only re-enters the password.
      if (await window.chatward.server.allow(url)) { location.reload(); return; }
      await initDevice(accountKey(url, trimmed));
      // Reset goes through the same device handling as login, so this PC's existing keys and history stay with the account.
      const send = async (device: DeviceKeys) => {
        if (mode === 'reset') {
          return api.post<{ token: string; user: User }>('/api/auth/reset', { name: trimmed, code: resetCode.trim(), newPassword: password, device });
        }
        if (mode === 'login') {
          // With no password typed, this PC signs in with its device key. The server only accepts it for a PC already linked to the account.
          const body = password ? { name: trimmed, password, device } : { name: trimmed, device, proof: await deviceProof() };
          return api.post<{ token: string; user: User }>('/api/auth/login', body);
        }
        return api.post<{ token: string; user: User }>('/api/auth/register', { name: trimmed, device, inviteCode: signupCode.trim() });
      };
      // An old PC device is only adopted once the server accepts it for this account. If another account owns it, the server refuses and this account keeps its own device.
      // A password-less sign-in proves this PC's own device key, so an old device is not offered there.
      const legacy = mode === 'login' && !password ? null : await legacyDevice();
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
      setError(err instanceof ApiError ? sentence(err.message) : 'Could not reach the server.');
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
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'primary' : ''} onClick={() => switchTo('login')}>Log in</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'primary' : ''} onClick={() => switchTo('register')}>Create account</button>
          </div>
        )}

        {mode === 'register' && (
          <label className="cw-field">
            <span>Sign-up code</span>
            <input value={signupCode} onChange={(e) => setSignupCode(e.target.value)} spellCheck={false} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" required />
          </label>
        )}

        <label className="cw-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" spellCheck={false} maxLength={LIMITS.USERNAME_MAX} required />
          {mode === 'register' && <small className="cw-field-hint">What everyone sees, and what you log in with. Letters, digits, dots, dashes or underscores.</small>}
        </label>

        {mode === 'reset' && (
          <label className="cw-field">
            <span>Reset code from the server owner</span>
            <input value={resetCode} onChange={(e) => setResetCode(e.target.value)} spellCheck={false} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" required />
          </label>
        )}

        {mode !== 'register' && (
          <label className="cw-field">
            <span>{mode === 'reset' ? 'New password' : 'Password (only if you set one)'}</span>
            <span className="cw-password">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required={mode === 'reset'}
              />
              <button type="button" className="cw-password-toggle" onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword}>
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
            {mode === 'reset' && <small className="cw-field-hint">At least {LIMITS.PASSWORD_MIN} characters. A few random words work well.</small>}
          </label>
        )}

        {editServer ? (
          <label className="cw-field">
            <span>Server address</span>
            <input value={serverUrl} onChange={(e) => setServerUrlField(e.target.value)} placeholder="https://chat.example.com" autoComplete="url" spellCheck={false} required />
          </label>
        ) : (
          <p className="cw-auth-server">
            Server: {displayHost(serverUrl)}{' '}
            <button type="button" className="cw-auth-link" onClick={() => setEditServer(true)}>Change</button>
          </p>
        )}

        {error && <p className="cw-auth-error" role="alert">{error}</p>}

        <button type="submit" className="primary cw-auth-submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : mode === 'reset' ? 'Set new password' : 'Create account'}
        </button>
        {mode === 'login' && (
          <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => switchTo('reset')}>
            Forgot password?
          </button>
        )}
        {mode === 'reset' && (
          <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => switchTo('login')}>
            Back to log in
          </button>
        )}
        <button type="button" className="cw-auth-demo" disabled={busy} onClick={() => void enterDemo()}>
          Try demo (offline, no server)
        </button>
        {buildLabel() && <p className="cw-auth-build">{buildLabel()}</p>}
      </form>
    </div>
  );
}

/** Server errors come in lowercase; the form shows them as a sentence. */
function sentence(message: string): string {
  const s = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The address without its scheme, as people would say it. */
function displayHost(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Trims, drops trailing slashes, and assumes http:// when no scheme is typed. */
function normalizeUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}
