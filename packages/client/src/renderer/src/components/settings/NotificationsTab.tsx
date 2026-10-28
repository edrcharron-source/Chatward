import { playSound, type SoundKind } from '../../notify/notify';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';
import { Section, Slider, Toggle } from './controls';

const PREVIEWS: { kind: SoundKind; label: string }[] = [
  { kind: 'message', label: 'Message' },
  { kind: 'join', label: 'Join' },
  { kind: 'leave', label: 'Leave' },
];

export default function NotificationsTab() {
  const messageSounds = useSettings((s) => s.messageSounds);
  const voiceJoinLeaveSounds = useSettings((s) => s.voiceJoinLeaveSounds);
  const soundVolume = useSettings((s) => s.soundVolume);
  const mutedChannels = useSettings((s) => s.mutedChannels);
  const set = useSettings((s) => s.set);
  const servers = useSession((s) => s.servers);

  function setMuted(channelId: string, muted: boolean) {
    set({ mutedChannels: muted ? [...mutedChannels, channelId] : mutedChannels.filter((id) => id !== channelId) });
  }

  return (
    <>
      <Section title="Sounds">
        <Toggle label="Message sounds" hint="A tone when a new message arrives in a channel you are not reading."
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

      <Section title="Silence channels">
        {servers.length === 0 && <p className="muted">Join a server to choose which channels stay silent.</p>}
        {servers.map((b) => {
          const texts = b.channels.filter((c) => c.kind === 'text');
          if (texts.length === 0) return null;
          return (
            <div key={b.server.id} className="channel-group">
              <h4>{b.server.name}</h4>
              {texts.map((c) => (
                <Toggle key={c.id} label={`#${c.name}`} hint="No message sound for this channel."
                  checked={mutedChannels.includes(c.id)} onChange={(on) => setMuted(c.id, on)} />
              ))}
            </div>
          );
        })}
      </Section>
    </>
  );
}
