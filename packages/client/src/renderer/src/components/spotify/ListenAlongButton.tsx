import { useState } from 'react';
import { sendMessage } from '../../state/chat';
import { useSession } from '../../state/session';
import { useSpotify } from '../../state/spotify';

/** Composer button: posts an "Invite to Listen Along" card. Shown only while you are sharing a song of your own. */
export default function ListenAlongButton({ channelId, onError }: { channelId: string; onError: (msg: string | null) => void }) {
  const meId = useSession((s) => s.user?.id);
  const mine = useSpotify((s) => (meId ? s.activities[meId] : undefined));
  const [busy, setBusy] = useState(false);
  if (!mine || mine.alongWith) return null;

  async function invite() {
    setBusy(true);
    onError(null);
    try {
      await sendMessage(channelId, { text: '', files: [], listenAlong: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send the invite');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="icon media-toolbar-btn" disabled={busy} onClick={() => void invite()}
      aria-label="Invite to Listen Along on Spotify" title={`Invite everyone to listen along to ${mine.title}`}>
      🎧
    </button>
  );
}
