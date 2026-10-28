import { useCallback, useState, type ReactElement } from 'react';
import { useVoice } from '../../state/voice';
import ScreenPicker from './ScreenPicker';
import { setScreenShareOptions, type ScreenShareOptions } from './media';

type Pending = 'camera' | 'screen' | null;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function ShareControls(): ReactElement {
  const cameraOn = useVoice((s) => s.cameraOn);
  const screenOn = useVoice((s) => s.screenOn);
  const connected = useVoice((s) => s.status === 'connected' && s.room !== null);
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
    <div role="group" aria-label="Camera and screen share" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          aria-pressed={cameraOn}
          aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          disabled={disabled}
          className={cameraOn ? 'primary' : undefined}
          onClick={() => void run('camera', () => setCamera(!cameraOn))}
        >
          {cameraOn ? 'Camera on' : 'Camera off'}
        </button>
        <button
          type="button"
          aria-pressed={screenOn}
          aria-label={screenOn ? 'Stop sharing' : 'Share screen'}
          title={screenOn ? 'Stop sharing' : 'Share screen'}
          disabled={disabled}
          className={screenOn ? 'danger' : undefined}
          onClick={() => (screenOn ? void run('screen', () => setScreen(false)) : setPickerOpen(true))}
        >
          {screenOn ? 'Stop sharing' : 'Share'}
        </button>
      </div>
      {error && <p role="alert" className="muted" style={{ margin: 0, color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
      {pickerOpen && <ScreenPicker onPick={share} onClose={closePicker} />}
    </div>
  );
}
