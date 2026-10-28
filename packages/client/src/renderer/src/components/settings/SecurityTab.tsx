import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Member } from '@chatward/shared';
import { api } from '../../api/http';
import { acceptContactKeys, changedContacts, getDevice, onKeysChanged, safetyNumber } from '../../crypto';
import { useSession } from '../../state/session';
import { Section, errorText } from './controls';

interface OwnDevice {
  deviceId: string;
  createdAt: number;
}

/** Lists this account's devices and lets one be removed. Removing a device stops it getting new messages. */
function YourDevices() {
  const [devices, setDevices] = useState<OwnDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The device whose Remove form is open, and the password typed into it.
  const [pending, setPending] = useState<OwnDevice | null>(null);
  const [password, setPassword] = useState('');
  const thisDevice = getDevice().deviceId;

  async function load() {
    try {
      const res = await api.get<{ devices: OwnDevice[] }>('/api/me/devices');
      setDevices(res.devices);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => { void load(); }, []);

  function openRemove(d: OwnDevice) {
    setPending(d);
    setPassword('');
    setError(null);
  }

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/me/devices/${encodeURIComponent(pending.deviceId)}`, { password });
      setPending(null);
      setPassword('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Your devices">
      <p className="muted">
        Every computer you have signed in on. Remove any device you no longer use, or no longer have.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {devices === null && !error && <p className="muted">Loading…</p>}
      {devices?.length === 0 && <p className="muted">No devices to show.</p>}
      {devices?.map((d) => (
        <div key={d.deviceId}>
          <div className="setting-row">
            <span className="setting-text">
              <span>{d.deviceId === thisDevice ? 'This device' : `Device ${d.deviceId.slice(0, 8)}`}</span>
              <small className="muted">Added {new Date(d.createdAt).toLocaleDateString()}</small>
            </span>
            {d.deviceId !== thisDevice && (
              <button type="button" className="danger" onClick={() => openRemove(d)} disabled={busy}>Remove</button>
            )}
          </div>
          {pending?.deviceId === d.deviceId && (
            <form onSubmit={remove}>
              <p className="muted">
                Removing it signs it out at once and stops it getting new messages once your friends update their copies of your chats. It keeps any messages it already has. Enter your password to confirm.
              </p>
              <label className="field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
              </label>
              <button type="submit" className="danger" disabled={busy}>Remove device</button>
              <button type="button" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
            </form>
          )}
        </div>
      ))}
    </Section>
  );
}

export default function SecurityTab() {
  const servers = useSession((s) => s.servers);

  // Each person once, even if they share several servers with you.
  const people = useMemo(() => {
    const seen = new Map<string, Member>();
    for (const b of servers) for (const m of b.members) if (!seen.has(m.user.id)) seen.set(m.user.id, m);
    return [...seen.values()];
  }, [servers]);

  const [numbers, setNumbers] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const m of people) out[m.user.id] = m.devices.length ? await safetyNumber(m.devices) : '';
      if (active) setNumbers(out);
    })().catch(() => {});
    return () => { active = false; };
  }, [people]);

  const [changes, setChanges] = useState(changedContacts);
  useEffect(() => onKeysChanged(() => setChanges(changedContacts())), []);

  return (
    <>
      {changes.length > 0 && (
        <Section title="Keys changed">
          <p className="muted">
            These people&apos;s encryption keys changed. This is expected if they signed in on a new device, but it is also
            what happens if someone is intercepting your chats. Check the new safety number with them in person or on a call
            before you accept it.
          </p>
          {changes.map((c) => (
            <div key={c.userId} className="setting-section key-change">
              <strong>{c.name}</strong>
              <div className="safety-number" aria-label={`New safety number for ${c.name}`}>{c.number}</div>
              <button onClick={() => { acceptContactKeys(c.userId).catch(() => {}); }}>
                I checked it, trust the new keys
              </button>
            </div>
          ))}
        </Section>
      )}
      <YourDevices />
      <Section title="Safety numbers">
        <p className="muted">
          Compare a safety number with a friend over a call or in person. If they match, nobody is intercepting your chats.
        </p>
        {people.length === 0 && <p className="muted">Join a server to see member safety numbers.</p>}
        {people.map((m) => (
          <div key={m.user.id} className="setting-section">
            <strong>{m.user.displayName}</strong>
            <small className="muted">{m.devices.length} {m.devices.length === 1 ? 'device' : 'devices'}</small>
            <div className="safety-number" aria-label={`Safety number for ${m.user.displayName}`}>
              {numbers[m.user.id] || (m.devices.length ? '…' : 'No devices registered')}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
