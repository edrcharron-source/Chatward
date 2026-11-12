import { DEMO_URL } from '../../demo';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import PixelIcon, { type PixelIconName } from '../icons/PixelIcon';
import SoundboardButton from '../soundboard/SoundboardButton';
import ShareControls from './ShareControls';
import { SignalButton, signalLevel, useRoomPing } from './SignalIcon';

/**
 * Your call's status and controls. `stacked` (the tabs layout's corner card) puts the controls in pairs down a narrow
 * column: mute and deafen, camera and screen share, the soundboard, then Leave.
 */
/** The call buttons show pixel icons; each one's name is in its tooltip and accessible label. */
const ICON = 18;

/**
 * `bar` (the LCARS frame's bottom bar) lays the controls out in one row of labelled segments, with the call's status and
 * Leave at the right end. Out of a call it offers Join voice there instead.
 */
/** `words` (the Orbit layout's corner card) puts each button's name next to its icon. */
/** `phone` puts the controls in one row of large round buttons under the call, for thumbs. */
export default function VoiceDock({ stacked = false, words = false, bar, phone = false }: { stacked?: boolean; words?: boolean; bar?: { onJoin: (() => void) | null }; phone?: boolean }) {
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
  const room = useVoice((s) => s.room);
  const ms = useRoomPing(room);

  const seg = bar ? 'lcars-seg' : '';
  const cls = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ') || undefined;
  // In the bar each button shows its name; elsewhere its pixel icon.
  const face = (word: string, icon: PixelIconName) =>
    bar ? <span className="lcars-label">{word}</span>
      : words ? <><PixelIcon name={icon} size={ICON} /><span className="cw-call-word">{word}</span></>
        : <PixelIcon name={icon} size={ICON} />;
  const dismiss = (
    <button type="button" className={cls(seg)} onClick={() => useVoice.setState({ notice: null })}>
      {bar ? <span className="lcars-label">Dismiss</span> : 'Dismiss'}
    </button>
  );

  if (!channelId && bar) {
    return (
      <div className="lcars-dock" role="group" aria-label="Voice chat">
        {bar.onJoin && (
          <button type="button" className="lcars-seg" onClick={bar.onJoin}><span className="lcars-label">Join voice</span></button>
        )}
        <span className="lcars-fill" aria-hidden="true" />
        {notice && <span role="status" className="lcars-alert">{notice}</span>}
        {notice && dismiss}
        <span className="lcars-status">Voice · not in call</span>
        <span className="lcars-cap" aria-hidden="true" />
      </div>
    );
  }

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
      className={cls(seg, muted && 'danger')}
      aria-pressed={muted}
      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      title={muted ? 'Unmute' : 'Mute'}
      disabled={status !== 'connected' || deafened}
      onClick={toggleMute}
    >
      {face(muted ? 'Unmute' : 'Mute', muted ? 'micoff' : 'mic')}
    </button>
  );
  const deafenButton = (
    <button
      className={cls(seg, deafened && 'danger')}
      aria-pressed={deafened}
      aria-label={deafened ? 'Undeafen' : 'Deafen'}
      title={deafened ? 'Undeafen' : 'Deafen'}
      disabled={status !== 'connected'}
      onClick={toggleDeafen}
    >
      {face(deafened ? 'Undeafen' : 'Deafen', deafened ? 'deafenoff' : 'deafen')}
    </button>
  );
  const loopbackButton = demo && (
    <button
      aria-pressed={demoLoopback}
      aria-label={demoLoopback ? 'Loopback on' : 'Loopback off'}
      title={`Hear your own microphone through the speakers (demo only): ${demoLoopback ? 'on' : 'off'}`}
      className={cls(seg, demoLoopback && 'primary')}
      onClick={() => setDemoLoopback(!demoLoopback)}
    >
      {face('Loopback', 'loopback')}
    </button>
  );
  const soundboardButton = channel && (
    <SoundboardButton serverId={channel.serverId} channelId={channel.id} labelled={!!bar} words={words} className={cls(seg)} />
  );
  const leaveButton = (
    <button className={cls(seg, 'danger', bar && 'lcars-end')} aria-label="Leave voice" title="Leave voice" onClick={() => void leave()}>
      {face(words ? 'Leave voice' : 'Leave', 'leave')}
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

  const short = status === 'connected' ? 'Connected' : status === 'error' ? 'Not connected' : 'Connecting…';
  const signal = demo ? { bars: 3 as const, color: '#3ba55d', text: 'Demo mode, no live ping' } : signalLevel(ms);
  const shownSignal = status === 'connected' ? signal : { bars: 0 as const, color: 'var(--text-muted, #888)', text: short };
  const signalButton = <SignalButton bars={shownSignal.bars} color={shownSignal.color} text={shownSignal.text} />;

  if (bar) {
    return (
      <div className="lcars-dock" role="group" aria-label="Voice chat">
        {muteButton}
        {deafenButton}
        <ShareControls labelled />
        {soundboardButton}
        {loopbackButton}
        <span className="lcars-fill" aria-hidden="true" />
        {error && <span role="alert" className="lcars-alert">{error}</span>}
        {notice && <span role="status" className="lcars-alert">{notice}</span>}
        {notice && dismiss}
        <span className={`lcars-status${status === 'connected' ? ' live' : ''}`}>
          {signalButton}
          <span>Voice · {short}</span>
        </span>
        {leaveButton}
      </div>
    );
  }

  if (phone) {
    return (
      <div className="cw-call-phone" role="group" aria-label="Voice chat">
        <div className="cw-call-phone-status">{signalButton}<span>Voice · {short}</span></div>
        {notices}
        <div className="cw-call-phone-row">
          {muteButton}{deafenButton}<ShareControls />{soundboardButton}{loopbackButton}{leaveButton}
        </div>
      </div>
    );
  }

  if (stacked) {
    return (
      <div className="cw-call-stack" role="group" aria-label="Voice chat">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 20 }}>
          {signalButton}
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', minHeight: 20 }}>
            <div className="cw-call-status" style={{ fontWeight: 600, color: 'var(--text-strong)', lineHeight: '20px' }}>Voice chat · {short}</div>
          </div>
        </div>
        {notices}
        <div className="cw-call-pair">{muteButton}{deafenButton}</div>
        <ShareControls words={words} />
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
