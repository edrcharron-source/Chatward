import { useCallback, useState, type ReactElement } from 'react';
import { isDemo } from '../../demo';
import { useVoice } from '../../state/voice';
import PixelIcon from '../icons/PixelIcon';
import ScreenPicker from './ScreenPicker';
import { setScreenShareOptions, type ScreenShareOptions } from './media';

type Pending = 'camera' | 'screen' | null;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `labelled` (the LCARS bottom bar) shows each button's name instead of its icon, and lays the buttons out flat. */
/** `words` keeps the icon and adds the button's name beside it. */
export default function ShareControls({ labelled = false, words = false }: { labelled?: boolean; words?: boolean } = {}): ReactElement {
  const cameraOn = useVoice((s) => s.cameraOn);
  const screenOn = useVoice((s) => s.screenOn);
  const connected = useVoice((s) => s.status === 'connected' && (s.room !== null || isDemo()));
  const setCamera = useVoice((s) => s.setCamera);
  const setScreen = useVoice((s) => s.setScreen);

  const [pending, setPending] = useState<Pending>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: Exclude<Pending, null>, action: () => Promise<void>) => {
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  };

  const share = (sourceId: string, opts: ScreenShareOptions) => {
    setPickerOpen(false);
    setScreenShareOptions(opts);
    void run('screen', () => setScreen(true, sourceId));
  };

  const closePicker = useCallback(() => setPickerOpen(false), []);
  const disabled = !connected || pending !== null;

  return (
    <div role="group" aria-label="Camera and screen share" className={labelled ? 'lcars-flat' : undefined}
      style={labelled ? undefined : { display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className={labelled ? 'lcars-flat' : undefined} style={labelled ? undefined : { display: 'flex', gap: 8 }}>
        <button
          type="button"
          aria-pressed={cameraOn}
          aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          disabled={disabled}
          className={[labelled ? 'lcars-seg' : '', cameraOn ? 'primary' : ''].filter(Boolean).join(' ') || undefined}
          onClick={() => void run('camera', () => setCamera(!cameraOn))}
        >
          {labelled ? <span className="lcars-label">{cameraOn ? 'Camera on' : 'Camera'}</span> : <PixelIcon name={cameraOn ? 'camera' : 'cameraoff'} size={18} />}
          {words && <span className="cw-call-word">{cameraOn ? 'Camera on' : 'Camera'}</span>}
        </button>
        <button
          type="button"
          aria-pressed={screenOn}
          aria-label={screenOn ? 'Stop sharing' : 'Share screen'}
          title={screenOn ? 'Stop sharing' : 'Share screen'}
          disabled={disabled}
          className={[labelled ? 'lcars-seg' : '', screenOn ? 'danger' : ''].filter(Boolean).join(' ') || undefined}
          onClick={() => (screenOn ? void run('screen', () => setScreen(false)) : setPickerOpen(true))}
        >
          {labelled ? <span className="lcars-label">{screenOn ? 'Stop stream' : 'Stream'}</span> : <PixelIcon name={screenOn ? 'shareoff' : 'share'} size={18} />}
          {words && <span className="cw-call-word">{screenOn ? 'Stop share' : 'Share'}</span>}
        </button>
      </div>
      {error && <p role="alert" className={labelled ? 'muted lcars-alert' : 'muted'} style={{ margin: 0, color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
      {pickerOpen && <ScreenPicker onPick={share} onClose={closePicker} />}
    </div>
  );
}
