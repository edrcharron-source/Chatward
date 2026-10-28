import { useState, type FormEvent } from 'react';
import { DEFAULT_VOICE_BITRATE_KBPS, LIMITS, VOICE_BITRATES_KBPS, type Channel } from '@chatward/shared';
import { api } from '../../api/http';
import { useSession } from '../../state/session';
import Dialog from './Dialog';
import { errorText } from './util';

/** Admin-only settings for one channel: its name, the audio bitrate for voice channels, and deletion. */
export default function ChannelSettingsDialog({ channel, onClose, onReload }: { channel: Channel; onClose: () => void; onReload: () => Promise<void> }) {
  const [name, setName] = useState(channel.name);
  const [bitrate, setBitrate] = useState(channel.bitrateKbps ?? DEFAULT_VOICE_BITRATE_KBPS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Name the channel.'); return; }
    const body: { name: string; bitrateKbps?: number } = { name: trimmed };
    if (channel.kind === 'voice') body.bitrateKbps = bitrate;
    setBusy(true);
    setError(null);
    try {
      await api.patch<{ channel: Channel }>(`/api/servers/${channel.serverId}/channels/${channel.id}`, body);
      await onReload();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete #${channel.name}? Its messages are deleted for everyone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/servers/${channel.serverId}/channels/${channel.id}`);
      useSession.getState().removeChannel(channel.serverId, channel.id);
      await onReload();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={`${channel.name} settings`} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Channel name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.CHANNEL_NAME_MAX} autoFocus required />
        </label>
        {channel.kind === 'voice' && (
          <>
            <label>
              Audio bitrate
              <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>
                {VOICE_BITRATES_KBPS.map((kbps) => (
                  <option key={kbps} value={kbps}>{kbps} kbps{kbps === DEFAULT_VOICE_BITRATE_KBPS ? ' (default)' : ''}</option>
                ))}
              </select>
            </label>
            <p className="cw-hint">Higher bitrates sound fuller but use more bandwidth. Applies to everyone in this channel.</p>
          </>
        )}
        {error && <p className="cw-error" role="alert">{error}</p>}
        <div className="cw-dialog-actions">
          <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Delete channel</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}
