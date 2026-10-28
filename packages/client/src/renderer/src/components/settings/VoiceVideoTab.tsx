import { useCallback, useEffect, useRef, useState } from 'react';
import { playSound } from '../../notify/notify';
import { useSettings } from '../../state/settings';
import { Section, Slider, Toggle, errorText } from './controls';

interface Devices { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }

function DeviceSelect({ label, value, devices, onChange }: {
  label: string; value: string; devices: MediaDeviceInfo[]; onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>
        ))}
      </select>
    </label>
  );
}

export default function VoiceVideoTab() {
  const inputDeviceId = useSettings((s) => s.inputDeviceId);
  const outputDeviceId = useSettings((s) => s.outputDeviceId);
  const cameraDeviceId = useSettings((s) => s.cameraDeviceId);
  const masterVolume = useSettings((s) => s.masterVolume);
  const micGain = useSettings((s) => s.micGain);
  const noiseSuppression = useSettings((s) => s.noiseSuppression);
  const echoCancellation = useSettings((s) => s.echoCancellation);
  const set = useSettings((s) => s.set);

  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [], cameras: [] });
  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices({
      inputs: all.filter((d) => d.kind === 'audioinput'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
      cameras: all.filter((d) => d.kind === 'videoinput'),
    });
  }, []);

  useEffect(() => {
    void refreshDevices().catch(() => {});
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // Live input meter. Shows the level after mic gain, which is what the call hears.
  const meterRef = useRef<HTMLDivElement>(null);
  const [micError, setMicError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let frame = 0;
    let active = true;
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined, noiseSuppression, echoCancellation },
      });
      if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
      setMicError(null);
      void refreshDevices().catch(() => {}); // device labels are only available once mic permission is granted
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const level = Math.min(1, Math.sqrt(sum / buf.length) * useSettings.getState().micGain * 4);
        if (meterRef.current) meterRef.current.style.width = `${(level * 100).toFixed(1)}%`;
        frame = requestAnimationFrame(tick);
      };
      tick();
    })().catch((e) => { if (active) setMicError(errorText(e)); });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [inputDeviceId, noiseSuppression, echoCancellation, refreshDevices]);

  // Camera stays off until the user asks to preview it.
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewCam, setPreviewCam] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  useEffect(() => {
    if (!previewCam) return;
    let stream: MediaStream | null = null;
    let active = true;
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
      });
      if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCamError(null);
    })().catch((e) => { if (active) setCamError(errorText(e)); });
    return () => {
      active = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [previewCam, cameraDeviceId]);

  return (
    <>
      <Section title="Devices">
        <DeviceSelect label="Microphone" value={inputDeviceId} devices={devices.inputs}
          onChange={(id) => set({ inputDeviceId: id })} />
        <DeviceSelect label="Speakers" value={outputDeviceId} devices={devices.outputs}
          onChange={(id) => set({ outputDeviceId: id })} />
        <DeviceSelect label="Camera" value={cameraDeviceId} devices={devices.cameras}
          onChange={(id) => set({ cameraDeviceId: id })} />
        <div className="row-actions">
          <button type="button" onClick={() => playSound('message')}>Play test tone</button>
        </div>
      </Section>

      <Section title="Input">
        <div className="field">
          <span className="muted">Input level</span>
          <div className="meter" aria-hidden><div ref={meterRef} /></div>
          {micError && <p className="error-text" role="status">{micError}</p>}
        </div>
        <Slider label="Mic gain" value={micGain} min={0} max={2} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ micGain: v })} />
        <Toggle label="Noise suppression" checked={noiseSuppression}
          onChange={(on) => set({ noiseSuppression: on })} />
        <Toggle label="Echo cancellation" checked={echoCancellation}
          onChange={(on) => set({ echoCancellation: on })} />
      </Section>

      <Section title="Output">
        <Slider label="Master volume" value={masterVolume} min={0} max={1} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ masterVolume: v })} />
      </Section>

      <Section title="Camera">
        <div className="row-actions">
          <button type="button" aria-pressed={previewCam} onClick={() => setPreviewCam((on) => !on)}>
            {previewCam ? 'Stop preview' : 'Preview camera'}
          </button>
        </div>
        {previewCam && <video ref={videoRef} className="video-preview" autoPlay muted playsInline />}
        {camError && <p className="error-text" role="status">{camError}</p>}
      </Section>

      <p className="muted small">Device and audio processing changes apply the next time you join a call.</p>
    </>
  );
}
