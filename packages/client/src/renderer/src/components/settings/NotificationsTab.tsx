import { playSound, type SoundKind } from '../../notify/notify';
import { useSettings } from '../../state/settings';
import { Section, Slider, Toggle } from './controls';

const PREVIEWS: { kind: SoundKind; label: string }[] = [
  { kind: 'message', label: 'Message' },
  { kind: 'mention', label: 'Ping' },
  { kind: 'join', label: 'Join' },
  { kind: 'leave', label: 'Leave' },
];

export default function NotificationsTab() {
  const messageSounds = useSettings((s) => s.messageSounds);
  const voiceJoinLeaveSounds = useSettings((s) => s.voiceJoinLeaveSounds);
  const soundVolume = useSettings((s) => s.soundVolume);
  const silenceAll = useSettings((s) => s.silenceAll);
  const set = useSettings((s) => s.set);

  return (
    <>
      <Section title="Silence">
        <Toggle label="Silence all notifications" hint="No sounds and no taskbar flashing for messages, pings or voice. Highlights in chat still show."
          checked={silenceAll} onChange={(on) => set({ silenceAll: on })} />
      </Section>

      <Section title="Sounds">
        <Toggle label="Message sounds" hint="A tone when a new message arrives in a channel you are not reading. Pings use this too."
          checked={messageSounds} onChange={(on) => set({ messageSounds: on })} />
        <Toggle label="Voice join and leave sounds" hint="A tone when someone joins or leaves the call you are in."
          checked={voiceJoinLeaveSounds} onChange={(on) => set({ voiceJoinLeaveSounds: on })} />
        <Slider label="Sound volume" value={soundVolume} min={0} max={1} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ soundVolume: v })} />
        <div className="row-actions">
          {PREVIEWS.map((p) => (
            <button key={p.kind} type="button" onClick={() => playSound(p.kind)}>Test {p.label.toLowerCase()}</button>
          ))}
        </div>
      </Section>
    </>
  );
}
