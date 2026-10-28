import { useState, type FormEvent } from 'react';
import { DEFAULT_VOICE_BITRATE_KBPS, VOICE_BITRATES_KBPS, type Channel } from '@chatward/shared';
import { api } from '../../api/http';
import Dialog from './Dialog';
import { errorText } from './util';

/** Admin-only settings for one voice channel. */
export default function ChannelSettingsDialog({ channel, onClose, onReload }: { channel: Channel; onClose: () => void; onReload: () => Promise<void> }) {
  const [bitrate, setBitrate] = useState(channel.bitrateKbps ?? DEFAULT_VOICE_BITRATE_KBPS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch<{ channel: Channel }>(`/api/servers/${channel.serverId}/channels/${channel.id}`, { bitrateKbps: bitrate });
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
          Audio bitrate
          <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>
            {VOICE_BITRATES_KBPS.map((kbps) => (
              <option key={kbps} value={kbps}>{kbps} kbps{kbps === DEFAULT_VOICE_BITRATE_KBPS ? ' (default)' : ''}</option>
            ))}
          </select>
        </label>
        <p className="cw-hint">Higher bitrates sound fuller but use more bandwidth. Applies to everyone in this channel.</p>
        {error && <p className="cw-error" role="alert">{error}</p>}
        <div className="cw-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}
