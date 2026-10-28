import { useState, type FormEvent } from 'react';
import { LIMITS, type SoundboardSound } from '@chatward/shared';
import { api } from '../../api/http';

const EMOJI_PRESETS = ['😀', '😂', '🔥', '👏', '🎉', '😱', '👀', '💀', '🎺', '🥁', '🚨', '👍', '😎', '🐸', '🎵', '🤯'];
const NAME_MAX = 32;

export default function UploadSoundDialog({ serverId, onClose, onUploaded }: {
  serverId: string;
  onClose: () => void;
  onUploaded: (sound: SoundboardSound) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJI_PRESETS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickFile(f: File | undefined) {
    setError(null);
    setFile(null);
    if (!f) return;
    if (!f.type.startsWith('audio/')) { setError('Pick an audio file.'); return; }
    if (f.size > LIMITS.SOUND_MAX_BYTES) {
      setError(`Sounds must be ${LIMITS.SOUND_MAX_BYTES / 1024} KB or smaller.`);
      return;
    }
    let seconds: number;
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      seconds = buf.duration;
      await ctx.close();
    } catch {
      setError("Couldn't read that audio file.");
      return;
    }
    if (seconds > LIMITS.SOUND_MAX_SECONDS) {
      setError(`Sounds must be ${LIMITS.SOUND_MAX_SECONDS} seconds or shorter.`);
      return;
    }
    setDurationMs(Math.round(seconds * 1000));
    setFile(f);
    setName((current) => current || f.name.replace(/\.[^.]+$/, '').slice(0, NAME_MAX));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the sound a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ name: trimmed, emoji, durationMs: String(durationMs) });
      const bytes = await file.arrayBuffer();
      const { sound } = await api.putRaw<{ sound: SoundboardSound }>(
        'POST', `/api/servers/${serverId}/sounds?${qs}`, bytes, file.type,
      );
      onUploaded(sound);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-sound-title"
        onSubmit={submit}
        style={{ width: 360, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <h3 id="upload-sound-title" style={{ margin: 0, color: 'var(--text-strong)' }}>Upload sound</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted">Audio file (up to {LIMITS.SOUND_MAX_SECONDS}s)</span>
          <input type="file" accept="audio/*" disabled={busy} onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted">Name</span>
          <input
            value={name}
            maxLength={NAME_MAX}
            disabled={busy || !file}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="muted" id="sound-emoji-label">Emoji</span>
          <div role="radiogroup" aria-labelledby="sound-emoji-label" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {EMOJI_PRESETS.map((em) => (
              <button
                key={em}
                type="button"
                className="icon"
                role="radio"
                aria-checked={emoji === em}
                disabled={busy}
                onClick={() => setEmoji(em)}
                style={{
                  fontSize: 20, padding: 4,
                  outline: emoji === em ? '2px solid var(--accent)' : 'none',
                }}
              >
                {em}
              </button>
            ))}
          </div>
        </div>

        {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !file}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </div>
  );
}
