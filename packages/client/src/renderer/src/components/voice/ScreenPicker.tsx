import { useEffect, useState, type ReactElement } from 'react';
import { DEFAULT_SCREEN_OPTIONS, type ScreenShareOptions } from './media';

type ScreenSource = Awaited<ReturnType<Window['chatward']['getScreenSources']>>[number];

interface Props {
  onPick: (sourceId: string, opts: ScreenShareOptions) => void;
  onClose: () => void;
}

export default function ScreenPicker({ onPick, onClose }: Props): ReactElement {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  const [opts, setOpts] = useState<ScreenShareOptions>(DEFAULT_SCREEN_OPTIONS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.chatward.getScreenSources()
      .then((list) => { if (alive) setSources(list); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = (sources ?? []).filter((s) => (tab === 'screen' ? s.isScreen : !s.isScreen));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="screen-picker-title" style={{ width: 'min(720px, 92vw)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="screen-picker-title" style={{ margin: 0, fontSize: 18, color: 'var(--text-strong)' }}>Share your screen</h2>

        <div role="tablist" style={{ display: 'flex', gap: 8 }}>
          {(['screen', 'window'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'primary' : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'screen' ? 'Entire screen' : 'Application window'}
            </button>
          ))}
        </div>

        <div
          role="listbox"
          aria-label={tab === 'screen' ? 'Screens' : 'Windows'}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, maxHeight: 360, overflow: 'auto' }}
        >
          {sources === null && !error && <p className="muted">Loading sources...</p>}
          {sources !== null && shown.length === 0 && <p className="muted">Nothing to share here.</p>}
          {shown.map((s) => {
            const isSelected = selected === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => onPick(s.id, opts)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: 8,
                  background: isSelected ? 'var(--bg-hover)' : 'var(--bg-1)',
                  outline: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                <img src={s.thumbnail} alt="" style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', borderRadius: 6, background: 'var(--bg-0)' }} />
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {s.appIcon && <img src={s.appIcon} alt="" width={16} height={16} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || 'Untitled'}</span>
                </span>
              </button>
            );
          })}
        </div>

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <legend className="muted" style={{ padding: 0, marginBottom: 6 }}>Quality</legend>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Resolution
            <select value={opts.height} onChange={(e) => setOpts({ ...opts, height: Number(e.target.value) as 720 | 1080 })}>
              <option value={1080}>1080p</option>
              <option value={720}>720p</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Frame rate
            <select value={opts.frameRate} onChange={(e) => setOpts({ ...opts, frameRate: Number(e.target.value) as 30 | 60 })}>
              <option value={60}>60 fps</option>
              <option value={30}>30 fps</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={opts.systemAudio} onChange={(e) => setOpts({ ...opts, systemAudio: e.target.checked })} />
            Share system audio
          </label>
        </fieldset>

        {error && <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={selected === null} onClick={() => selected && onPick(selected, opts)}>
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
