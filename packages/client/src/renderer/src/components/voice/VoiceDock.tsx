import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import ShareControls from './ShareControls';

export default function VoiceDock() {
  const channelId = useVoice((s) => s.channelId);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const toggleMute = useVoice((s) => s.toggleMute);
  const toggleDeafen = useVoice((s) => s.toggleDeafen);
  const leave = useVoice((s) => s.leave);
  const channelName = useSession((s) => s.servers.flatMap((b) => b.channels).find((c) => c.id === channelId)?.name);

  if (!channelId) return null;

  const label = status === 'connected' ? 'Voice connected' : status === 'error' ? 'Not connected' : 'Connecting…';
  const dot = status === 'connected' ? 'var(--ok)' : status === 'error' ? 'var(--danger)' : 'var(--warn)';

  return (
    <div className="card" style={{ margin: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: 'none' }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{label}</div>
          <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {channelName ?? 'Voice'}
          </div>
        </div>
      </div>
      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          className={muted ? 'danger' : undefined}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          disabled={status !== 'connected' || deafened}
          onClick={toggleMute}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className={deafened ? 'danger' : undefined}
          aria-pressed={deafened}
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
          disabled={status !== 'connected'}
          onClick={toggleDeafen}
        >
          {deafened ? 'Undeafen' : 'Deafen'}
        </button>
        <ShareControls />
        <button className="danger" onClick={() => void leave()}>Leave</button>
      </div>
    </div>
  );
}
