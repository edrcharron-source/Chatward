import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { LIMITS, type User } from '@chatward/shared';
import { api, fetchObjectUrl } from '../../api/http';
import { useSession } from '../../state/session';
import { cropToAvatar } from './avatar';
import { Section, errorText } from './controls';
import ProfileEditor from '../profile/ProfileEditor';
import PasswordSection from './PasswordSection';

interface Status { ok: boolean; text: string }

export default function AccountTab() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(user?.displayName ?? '');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const [current, setCurrent] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const avatarPath = user?.avatarUrl ?? null;

  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);

  // Avatars need the auth header, so fetch them as object URLs.
  useEffect(() => {
    if (!avatarPath) { setCurrent(null); return; }
    let url: string | null = null;
    let active = true;
    fetchObjectUrl(avatarPath)
      .then((u) => {
        if (!active) { URL.revokeObjectURL(u); return; }
        url = u;
        setCurrent(u);
      })
      .catch(() => { if (active) setCurrent(null); });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [avatarPath, rev]);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source); }, [source]);

  if (!user) return null;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setStatus({ ok: false, text: 'Display name cannot be empty.' });
      return;
    }
    setBusy(true);
    try {
      const res = await api.patch<{ user: User }>('/api/me', { displayName });
      setUser(res.user);
      setName(res.user.displayName);
      setStatus({ ok: true, text: 'Display name saved.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setStatus({ ok: false, text: 'Pick a PNG, JPEG or WebP image.' });
      return;
    }
    setSource(URL.createObjectURL(file));
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setArea(null);
  }

  async function saveAvatar() {
    if (!source || !area) return;
    setBusy(true);
    try {
      const blob = await cropToAvatar(source, area, LIMITS.AVATAR_MAX_BYTES);
      const res = await api.putRaw<{ user: User }>('PUT', '/api/me/avatar', blob, 'image/webp');
      setUser(res.user);
      setSource(null);
      setRev((r) => r + 1);
      setStatus({ ok: true, text: 'Profile picture updated.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title="Display name">
        <form className="setting-row" onSubmit={saveName}>
          <label className="field grow">
            <span>Shown to your friends. You log in with <strong>{user.username}</strong>.</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </label>
          <button type="submit" className="primary" disabled={busy || name.trim() === user.displayName}>Save</button>
        </form>
      </Section>

      <Section title="Profile picture">
        <div className="setting-row">
          {current
            ? <img className="avatar avatar-lg" src={current} alt="" />
            : <div className="avatar avatar-lg avatar-fallback" aria-hidden>{user.displayName.slice(0, 1).toUpperCase()}</div>}
          <div className="grow">
            <button type="button" onClick={() => fileRef.current?.click()}>Choose image…</button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPick} />
          </div>
        </div>

        {source && (
          <div className="crop-box">
            <div className="avatar-crop">
              <Cropper
                image={source}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, px) => setArea(px)}
              />
            </div>
            <label className="setting-row">
              <span className="setting-text"><span>Zoom</span></span>
              <input type="range" min={1} max={3} step={0.01} value={zoom} aria-label="Zoom"
                onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
            <div className="row-actions">
              <button type="button" className="primary" disabled={busy || !area} onClick={saveAvatar}>Save picture</button>
              <button type="button" onClick={() => setSource(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Section>

      <ProfileEditor user={user} />

      <PasswordSection />

      {status && <p className={status.ok ? 'ok-text' : 'error-text'} role="status">{status.text}</p>}
    </>
  );
}
