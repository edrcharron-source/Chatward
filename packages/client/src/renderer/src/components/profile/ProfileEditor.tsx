import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { Area } from 'react-easy-crop';
import { LIMITS, type User } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import { Section, errorText } from '../settings/controls';
import ImageCropper from './ImageCropper';
import { BANNER_ASPECT, cropToBanner } from './banner';
import './profile.css';

interface Status { ok: boolean; text: string }

/** Bio, pronouns, colors and banner image. Sits in Settings → Account. */
export default function ProfileEditor({ user }: { user: User }) {
  const setUser = useSession((s) => s.setUser);
  const fileRef = useRef<HTMLInputElement>(null);
  const profile = user.profile;

  const [bio, setBio] = useState(profile.bio);
  const [pronouns, setPronouns] = useState(profile.pronouns);
  const [accent, setAccent] = useState(profile.accentColor ?? '#34c9b4');
  const [bannerColor, setBannerColor] = useState(profile.bannerColor ?? '#34c9b4');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const [source, setSource] = useState<string | null>(null);
  const [area, setArea] = useState<Area | null>(null);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source); }, [source]);

  async function saveText(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.patch<{ user: User }>('/api/me', {
        bio,
        pronouns,
        accentColor: accent,
        bannerColor: bannerColor,
      });
      setUser(res.user);
      setStatus({ ok: true, text: 'Profile saved.' });
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
    setArea(null);
  }

  async function saveBanner() {
    if (!source || !area) return;
    setBusy(true);
    try {
      const blob = await cropToBanner(source, area, LIMITS.BANNER_MAX_BYTES);
      const res = await api.putRaw<{ user: User }>('PUT', '/api/me/banner', blob, 'image/webp');
      setUser(res.user);
      setSource(null);
      setStatus({ ok: true, text: 'Banner updated.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function removeBanner() {
    setBusy(true);
    try {
      const res = await api.del<{ user: User }>('/api/me/banner');
      setUser(res.user);
      setStatus({ ok: true, text: 'Banner removed.' });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title="Profile">
        <form className="profile-editor" onSubmit={saveText}>
          <label className="field">
            <span>Pronouns</span>
            <input value={pronouns} maxLength={LIMITS.PRONOUNS_MAX} onChange={(e) => setPronouns(e.target.value)} />
          </label>
          <label className="field">
            <span>About me</span>
            <textarea value={bio} maxLength={LIMITS.BIO_MAX} onChange={(e) => setBio(e.target.value)} />
          </label>
          <div className="color-row">
            <label>
              <span>Accent color</span>
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
            </label>
            <label>
              <span>Banner color</span>
              <input type="color" value={bannerColor} onChange={(e) => setBannerColor(e.target.value)} />
            </label>
          </div>
          <div className="row-actions">
            <button type="submit" className="primary" disabled={busy}>Save profile</button>
          </div>
        </form>
      </Section>

      <Section title="Banner">
        <div className="setting-row">
          <div className="grow">
            <button type="button" onClick={() => fileRef.current?.click()}>Choose image…</button>
            {profile.bannerUrl && <button type="button" onClick={removeBanner} disabled={busy}>Remove banner</button>}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPick} />
          </div>
        </div>
        {source && (
          <>
            <ImageCropper source={source} aspect={BANNER_ASPECT} onArea={setArea} />
            <div className="row-actions">
              <button type="button" className="primary" disabled={busy || !area} onClick={saveBanner}>Save banner</button>
              <button type="button" onClick={() => setSource(null)}>Cancel</button>
            </div>
          </>
        )}
      </Section>

      {status && <p className={status.ok ? 'ok-text' : 'error-text'} role="status">{status.text}</p>}
    </>
  );
}
