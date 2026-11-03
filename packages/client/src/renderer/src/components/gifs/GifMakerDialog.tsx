import { useEffect, useRef, useState, type DragEvent } from 'react';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { LIMITS, type LibraryGif } from '@chatward/shared';
import { addLibraryGif, parseTags } from '../../state/gifLibrary';
import { detailsProblem } from './GifDetailsDialog';
import { nameFromFile } from './AddGifsDialog';
import { encodeGif, estimateBytes, loadVideo, outputSize, type CropArea, type GifPlan } from './makeGif';

const MB = 1024 * 1024;
const MIN_SECONDS = 0.3;
const SHAPES = [
  { label: 'Original', aspect: 0 },
  { label: 'Square', aspect: 1 },
  { label: 'Wide', aspect: 16 / 9 },
  { label: 'Tall', aspect: 9 / 16 },
] as const;
const SIZES = [{ label: 'Small', width: 320 }, { label: 'Medium', width: 480 }] as const;
const SPEEDS = [{ label: 'Normal', fps: 10 }, { label: 'Smooth', fps: 15 }] as const;

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const fmtSize = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Makes a GIF from part of a video, on this PC. Pick a video, choose the part (up to 15 seconds), crop it,
 * pick a size and smoothness, then preview and save it to the server's GIFs. The video itself is never uploaded.
 */
export default function GifMakerDialog({ serverId, onClose, onSend }: {
  serverId: string;
  onClose: () => void;
  /** Called after "Save and send", with the saved GIF to put in the message. */
  onSend: (gif: LibraryGif) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [shape, setShape] = useState(0);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropArea | null>(null);
  const [width, setWidth] = useState<number>(SIZES[0].width);
  const [fps, setFps] = useState<number>(SPEEDS[0].fps);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; url: string } | null>(null);
  const [name, setName] = useState('');
  const [tagText, setTagText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const cancelled = useRef(false);
  const busy = progress !== null || saving;

  // Object URLs are freed when replaced and when the maker closes.
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  useEffect(() => () => { cancelled.current = true; }, []);

  // Keep the preview looping inside the chosen part.
  useEffect(() => {
    const v = previewRef.current;
    if (!v) return;
    const loop = () => { if (v.currentTime < start - 0.05 || v.currentTime >= end) v.currentTime = start; };
    v.addEventListener('timeupdate', loop);
    v.currentTime = start;
    return () => v.removeEventListener('timeupdate', loop);
  }, [start, end, src]);

  async function pickFile(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i.test(f.name)) { setError('Pick a video file.'); return; }
    const url = URL.createObjectURL(f);
    try {
      const v = await loadVideo(url);
      if (!Number.isFinite(v.duration) || v.duration <= 0 || !v.videoWidth) throw new Error("The app can't play this video. Try saving it as an .mp4 first.");
      setDuration(v.duration);
      setVideoSize({ width: v.videoWidth, height: v.videoHeight });
      setStart(0);
      setEnd(Math.min(v.duration, 5));
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setArea(null);
      setResult(null);
      setFile(f);
      setSrc(url);
      setName(nameFromFile(f.name));
      v.removeAttribute('src');
      v.load();
    } catch (err) {
      URL.revokeObjectURL(url);
      setError(err instanceof Error ? err.message : "Couldn't open that video.");
    }
  }

  const setStartClamped = (s: number) => {
    const next = Math.max(0, Math.min(s, duration - MIN_SECONDS));
    setStart(next);
    if (end <= next + MIN_SECONDS) setEnd(Math.min(duration, next + MIN_SECONDS));
    if (end - next > LIMITS.GIF_MAKER_MAX_SECONDS) setEnd(next + LIMITS.GIF_MAKER_MAX_SECONDS);
  };
  const setEndClamped = (e: number) => {
    const next = Math.min(duration, Math.max(e, MIN_SECONDS));
    setEnd(next);
    if (start >= next - MIN_SECONDS) setStart(Math.max(0, next - MIN_SECONDS));
    if (next - start > LIMITS.GIF_MAKER_MAX_SECONDS) setStart(next - LIMITS.GIF_MAKER_MAX_SECONDS);
  };

  const fullFrame: CropArea | null = videoSize ? { x: 0, y: 0, ...videoSize } : null;
  const plan: GifPlan | null = area || fullFrame ? { start, end, fps, crop: (area ?? fullFrame)!, width } : null;
  const estimate = plan ? estimateBytes(plan) : 0;
  const out = plan ? outputSize(plan) : null;

  async function make() {
    if (!plan || !src) return;
    setError(null);
    setResult(null);
    setProgress(0);
    cancelled.current = false;
    try {
      const video = await loadVideo(src, previewRef.current?.ownerDocument ?? document);
      const bytes = await encodeGif(video, plan, setProgress, () => cancelled.current);
      video.removeAttribute('src');
      video.load();
      setResult({ bytes, url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' })) });
    } catch (err) {
      if (!cancelled.current) setError(err instanceof Error ? err.message : "Couldn't make the GIF.");
    } finally {
      setProgress(null);
    }
  }

  async function save(send: boolean) {
    if (!result) return;
    const problem = detailsProblem(name, tagText);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      const gif = await addLibraryGif(serverId, result.bytes as Uint8Array<ArrayBuffer>, name.trim(), parseTags(tagText));
      if (send) onSend(gif);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setSaving(false);
    }
  }

  const tooBig = result ? result.bytes.byteLength > LIMITS.LIBRARY_GIF_MAX_BYTES : false;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!busy) void pickFile(e.dataTransfer.files[0]);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={onDrop}
    >
      <div className="modal gif-dialog gif-maker" role="dialog" aria-modal="true" aria-label="Make a GIF from a video">
        <h3 className="gif-dialog-title">Make a GIF from a video</h3>

        {!src && (
          <label className="gif-maker-pick">
            <span>Pick a video, or drop one here</span>
            <span className="muted">.mp4, .mov, .webm and most other videos. Your video stays on this PC; only the finished GIF is uploaded.</span>
            <input type="file" accept="video/*,.mkv,.mov" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        )}

        {src && !result && (
          <>
            <div className="gif-maker-crop">
              <Cropper
                video={src}
                crop={crop}
                zoom={zoom}
                aspect={SHAPES[shape].aspect || (videoSize ? videoSize.width / videoSize.height : 16 / 9)}
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, px) => setArea(px)}
                setVideoRef={(ref) => { previewRef.current = ref.current; }}
              />
            </div>
            <div className="gif-maker-row" role="radiogroup" aria-label="Crop shape">
              <span className="muted gif-maker-label">Crop</span>
              {SHAPES.map((s, i) => (
                <button key={s.label} type="button" role="radio" aria-checked={shape === i} className={shape === i ? 'primary' : ''} disabled={busy}
                  onClick={() => { setShape(i); setCrop({ x: 0, y: 0 }); }}>{s.label}</button>
              ))}
              <input type="range" min={1} max={4} step={0.01} value={zoom} aria-label="Zoom in to crop tighter" disabled={busy}
                onChange={(e) => setZoom(Number(e.target.value))} />
            </div>
            <div className="gif-maker-trim">
              <label>
                <span className="muted gif-maker-label">Start {fmtTime(start)}</span>
                <input type="range" min={0} max={duration} step={0.1} value={start} disabled={busy}
                  onChange={(e) => setStartClamped(Number(e.target.value))} aria-label="Start of the GIF" />
              </label>
              <label>
                <span className="muted gif-maker-label">End {fmtTime(end)}</span>
                <input type="range" min={0} max={duration} step={0.1} value={end} disabled={busy}
                  onChange={(e) => setEndClamped(Number(e.target.value))} aria-label="End of the GIF" />
              </label>
              <span className="muted">{(end - start).toFixed(1)} seconds (up to {LIMITS.GIF_MAKER_MAX_SECONDS})</span>
            </div>
            <div className="gif-maker-row" role="radiogroup" aria-label="Size">
              <span className="muted gif-maker-label">Size</span>
              {SIZES.map((s) => (
                <button key={s.label} type="button" role="radio" aria-checked={width === s.width} className={width === s.width ? 'primary' : ''} disabled={busy}
                  onClick={() => setWidth(s.width)}>{s.label}</button>
              ))}
              <span className="muted gif-maker-label">Smoothness</span>
              {SPEEDS.map((s) => (
                <button key={s.label} type="button" role="radio" aria-checked={fps === s.fps} className={fps === s.fps ? 'primary' : ''} disabled={busy}
                  onClick={() => setFps(s.fps)}>{s.label}</button>
              ))}
            </div>
            <p className="muted gif-note">
              {out && `${out.width} × ${out.height}, usually under ${fmtSize(estimate)}.`}
              {estimate > LIMITS.LIBRARY_GIF_MAX_BYTES && ` That may be over the ${LIMITS.LIBRARY_GIF_MAX_BYTES / MB} MB limit; try a shorter part, Small, or Normal.`}
            </p>
          </>
        )}

        {result && (
          <>
            <div className="gif-dialog-preview"><img src={result.url} alt="Your new GIF" className="gif-dialog-img" /></div>
            <p className={tooBig ? 'media-error' : 'muted gif-note'}>
              {fmtSize(result.bytes.byteLength)}
              {tooBig && ` is over the ${LIMITS.LIBRARY_GIF_MAX_BYTES / MB} MB limit. Go back and pick a shorter part, Small, or Normal.`}
            </p>
            {!tooBig && (
              <>
                <label className="gif-field">
                  <span className="muted">Name</span>
                  <input value={name} maxLength={LIMITS.LIBRARY_GIF_NAME_MAX} disabled={saving} autoFocus onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="gif-field">
                  <span className="muted">Tags (optional, separated by commas)</span>
                  <input value={tagText} disabled={saving} placeholder="reaction, funny" onChange={(e) => setTagText(e.target.value)} />
                </label>
              </>
            )}
          </>
        )}

        {progress !== null && (
          <div className="gif-maker-progress">
            <progress value={progress} max={1} />
            <span className="muted">Making your GIF… {Math.round(progress * 100)}%</span>
          </div>
        )}
        {error && <div role="alert" className="media-error">{error}</div>}

        <div className="gif-dialog-actions">
          {progress !== null ? (
            <button type="button" onClick={() => { cancelled.current = true; }}>Stop</button>
          ) : (
            <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          )}
          {src && !result && progress === null && (
            <>
              <button type="button" disabled={busy} onClick={() => { setSrc(null); setFile(null); }}>Pick another video</button>
              <button type="button" className="primary" disabled={!plan || end - start < MIN_SECONDS} onClick={() => void make()}>Make GIF</button>
            </>
          )}
          {result && (
            <>
              <button type="button" disabled={saving} onClick={() => setResult(null)}>Back to editing</button>
              {!tooBig && <button type="button" className="primary" disabled={saving} onClick={() => void save(false)}>{saving ? 'Saving…' : 'Save to server GIFs'}</button>}
              {!tooBig && <button type="button" className="primary" disabled={saving} onClick={() => void save(true)}>Save and send</button>}
            </>
          )}
        </div>
        {file && !result && <p className="muted gif-note gif-maker-file">{file.name}</p>}
      </div>
    </div>
  );
}
