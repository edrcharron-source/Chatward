import { DEMO_URL } from '../../demo';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import PixelIcon from '../icons/PixelIcon';
import SoundboardButton from '../soundboard/SoundboardButton';
import ShareControls from './ShareControls';

/**
 * Your call's status and controls. `stacked` (the tabs layout's corner card) puts the controls in pairs down a narrow
 * column: mute and deafen, camera and screen share, the soundboard, then Leave.
 */
/** The call buttons show pixel icons; each one's name is in its tooltip and accessible label. */
const ICON = 18;

export default function VoiceDock({ stacked = false }: { stacked?: boolean }) {
  const channelId = useVoice((s) => s.channelId);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const toggleMute = useVoice((s) => s.toggleMute);
  const toggleDeafen = useVoice((s) => s.toggleDeafen);
  const demo = useSession((s) => s.serverUrl === DEMO_URL);
  const demoLoopback = useVoice((s) => s.demoLoopback);
  const setDemoLoopback = useVoice((s) => s.setDemoLoopback);
  const leave = useVoice((s) => s.leave);
  const notice = useVoice((s) => s.notice);
  const channel = useSession((s) => s.servers.flatMap((b) => b.channels).find((c) => c.id === channelId));
  const channelName = channel?.name;

  if (!channelId) {
    if (!notice) return null;
    return (
      <div className="card" role="status" style={{ margin: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ color: 'var(--danger)', fontSize: 12 }}>{notice}</div>
        <button type="button" onClick={() => useVoice.setState({ notice: null })}>Dismiss</button>
      </div>
    );
  }

  const label = status === 'connected' ? 'Voice connected' : status === 'error' ? 'Not connected' : 'Connecting…';
  const dot = status === 'connected' ? 'var(--ok)' : status === 'error' ? 'var(--danger)' : 'var(--warn)';

  const muteButton = (
    <button
      className={muted ? 'danger' : undefined}
      aria-pressed={muted}
      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      title={muted ? 'Unmute' : 'Mute'}
      disabled={status !== 'connected' || deafened}
      onClick={toggleMute}
    >
      <PixelIcon name={muted ? 'micoff' : 'mic'} size={ICON} />
    </button>
  );
  const deafenButton = (
    <button
      className={deafened ? 'danger' : undefined}
      aria-pressed={deafened}
      aria-label={deafened ? 'Undeafen' : 'Deafen'}
      title={deafened ? 'Undeafen' : 'Deafen'}
      disabled={status !== 'connected'}
      onClick={toggleDeafen}
    >
      <PixelIcon name={deafened ? 'deafenoff' : 'deafen'} size={ICON} />
    </button>
  );
  const loopbackButton = demo && (
    <button
      aria-pressed={demoLoopback}
      aria-label={demoLoopback ? 'Loopback on' : 'Loopback off'}
      title={`Hear your own microphone through the speakers (demo only): ${demoLoopback ? 'on' : 'off'}`}
      className={demoLoopback ? 'primary' : undefined}
      onClick={() => setDemoLoopback(!demoLoopback)}
    >
      <PixelIcon name="loopback" size={ICON} />
    </button>
  );
  const soundboardButton = channel && <SoundboardButton serverId={channel.serverId} channelId={channel.id} />;
  const leaveButton = (
    <button className="danger" aria-label="Leave voice" title="Leave voice" onClick={() => void leave()}>
      <PixelIcon name="leave" size={ICON} />
    </button>
  );
  const notices = (
    <>
      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      {notice && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: 'var(--danger)', fontSize: 12 }}>{notice}</div>
          <button type="button" onClick={() => useVoice.setState({ notice: null })} style={{ alignSelf: 'flex-start' }}>Dismiss</button>
        </div>
      )}
    </>
  );

  if (stacked) {
    const short = status === 'connected' ? 'Connected' : status === 'error' ? 'Not connected' : 'Connecting…';
    return (
      <div className="cw-call-stack" role="group" aria-label="Voice chat">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: 'none' }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>Voice chat · {short}</div>
            <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {channelName ?? 'Voice'}
            </div>
          </div>
        </div>
        {notices}
        <div className="cw-call-pair">{muteButton}{deafenButton}</div>
        <ShareControls />
        <div className="cw-call-pair">{soundboardButton}{loopbackButton}</div>
        {leaveButton}
      </div>
    );
  }

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
      {notices}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {muteButton}
        {deafenButton}
        {loopbackButton}
        <ShareControls />
        {soundboardButton}
        {leaveButton}
      </div>
    </div>
  );
}
