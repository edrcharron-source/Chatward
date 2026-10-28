import { useEffect, useState } from 'react';
import type { Member, ServerFrame, SoundboardSound } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import { forgetSound, playSound } from './playback';
import UploadSoundDialog from './UploadSoundDialog';

const NO_MEMBERS: Member[] = [];

export default function SoundboardPanel({ serverId, channelId }: { serverId: string; channelId: string }) {
  const me = useSession((s) => s.user?.id);
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members ?? NO_MEMBERS);
  const myRole = members.find((m) => m.user.id === me)?.role;
  const inThisCall = useVoice((s) => s.channelId === channelId);
  const [sounds, setSounds] = useState<SoundboardSound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSounds([]);
    setError(null);
    api.get<{ sounds: SoundboardSound[] }>(`/api/servers/${serverId}/sounds`)
      .then((r) => { if (alive) setSounds(r.sounds); })
      .catch((e: Error) => { if (alive) setError(e.message); });

    const off = onFrame((f: ServerFrame) => {
      if (f.t === 'sound.new' && f.sound.serverId === serverId) {
        addSound(f.sound);
      } else if (f.t === 'sound.delete' && f.serverId === serverId) {
        forgetSound(f.soundId);
        setSounds((list) => list.filter((s) => s.id !== f.soundId));
      } else if (f.t === 'sound.play' && f.serverId === serverId && f.channelId === channelId && f.userId !== me) {
        // Others hear the clip through the call's mic track; this only lights up the button.
        setFlashId(f.soundId);
      }
    });
    return () => { alive = false; off(); };
  }, [serverId, channelId, me]);

  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 800);
    return () => clearTimeout(t);
  }, [flashId]);

  function addSound(sound: SoundboardSound) {
    setSounds((list) => (list.some((s) => s.id === sound.id) ? list : [...list, sound]));
  }

  async function handlePlay(sound: SoundboardSound) {
    setError(null);
    setFlashId(sound.id);
    try {
      await playSound(sound, channelId);
      await api.post(`/api/channels/${channelId}/sound-play`, { soundId: sound.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not play that sound.');
    }
  }

  async function handleDelete(sound: SoundboardSound) {
    if (!window.confirm(`Delete "${sound.name}"?`)) return;
    setError(null);
    try {
      await api.del(`/api/sounds/${sound.id}`);
      forgetSound(sound.id);
      setSounds((list) => list.filter((s) => s.id !== sound.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that sound.');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ color: 'var(--text-strong)' }}>Soundboard</strong>
        <button className="primary" onClick={() => setUploading(true)}>Upload sound</button>
      </div>

      {!inThisCall && <div className="muted">Join this voice channel to play sounds for everyone in the call.</div>}
      {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}

      {sounds.length === 0 ? (
        <div className="muted">No sounds yet. Upload a short clip to get started.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8 }}>
          {sounds.map((sound) => (
            <SoundTile
              key={sound.id}
              sound={sound}
              playing={flashId === sound.id}
              canDelete={sound.ownerId === me || myRole === 'owner' || myRole === 'admin'}
              onPlay={() => handlePlay(sound)}
              onDelete={() => handleDelete(sound)}
            />
          ))}
        </div>
      )}

      {uploading && (
        <UploadSoundDialog
          serverId={serverId}
          onClose={() => setUploading(false)}
          onUploaded={(sound) => { addSound(sound); setUploading(false); }}
        />
      )}
    </div>
  );
}

function SoundTile({ sound, playing, canDelete, onPlay, onDelete }: {
  sound: SoundboardSound;
  playing: boolean;
  canDelete: boolean;
  onPlay: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${sound.name}`}
        title={`${sound.name} (${(sound.durationMs / 1000).toFixed(1)}s)`}
        style={{
          width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          padding: '12px 8px', background: playing ? 'var(--accent)' : 'var(--bg-1)',
          color: playing ? 'var(--accent-text)' : 'var(--text)',
          transform: playing ? 'scale(0.97)' : 'none', transition: 'transform .1s, background .12s',
        }}
      >
        <span style={{ fontSize: 28, lineHeight: 1 }}>{sound.emoji}</span>
        <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sound.name}
        </span>
      </button>
      {canDelete && (
        <button
          type="button"
          className="icon"
          onClick={onDelete}
          aria-label={`Delete ${sound.name}`}
          title="Delete sound"
          style={{ position: 'absolute', top: 2, right: 2, padding: 2, fontSize: 12, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
