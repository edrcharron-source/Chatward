import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../../api/http';
import { DEMO_URL } from '../../demo';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';
import { errorText, isAdmin } from '../servers/util';

interface Target {
  userId: string;
  channelId: string;
  serverId: string;
}

/**
 * Right-click menu for someone in a voice call. Put `openMenu` on each row or tile for that person, and render `element` once.
 * Nothing opens for yourself: there is nothing to mute or kick.
 */
export function useMemberMenu() {
  const [menu, setMenu] = useState<(Target & { x: number; y: number }) | null>(null);
  const openMenu = (e: ReactMouseEvent, target: Target) => {
    e.preventDefault();
    setMenu({ ...target, x: e.clientX, y: e.clientY });
  };
  const element = menu && <MemberMenu {...menu} onClose={() => setMenu(null)} />;
  return { openMenu, element };
}

function MemberMenu({ x, y, userId, channelId, serverId, onClose }: Target & { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const selfId = useSession((s) => s.user?.id);
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members);
  const demo = useSession((s) => s.serverUrl === DEMO_URL);
  const volume = useSettings((s) => s.userVolumes[userId] ?? 1);
  const muted = useSettings((s) => s.mutedUsers[userId] === true);
  const setUserVolume = useSettings((s) => s.setUserVolume);
  const setUserMuted = useSettings((s) => s.setUserMuted);

  // close on an outside click or Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const doc = ref.current?.ownerDocument ?? document;
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const name = members?.find((m) => m.user.id === userId)?.user.displayName ?? 'this person';
  const me = members?.find((m) => m.user.id === selfId);
  const targetRole = members?.find((m) => m.user.id === userId)?.role;
  // mirrors the server rule; the server checks again, so this only decides whether to show the item
  const canKick = !demo && isAdmin(me) && userId !== selfId && targetRole !== 'owner' && !(targetRole === 'admin' && me?.role !== 'owner');
  const pct = Math.round(volume * 100);

  async function kick() {
    setError(null);
    try {
      await api.post('/api/voice/kick', { channelId, userId });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} options`}
      className="card"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 240),
        top: Math.min(y, window.innerHeight - 200),
        zIndex: 1000,
        width: 230,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div className="muted" style={{ fontSize: 12, padding: '4px 8px' }}>{name}</div>
      <button role="menuitem" type="button" onClick={() => setUserMuted(userId, !muted)} style={{ textAlign: 'left' }}>
        {muted ? 'Unmute for me' : 'Mute for me'}
      </button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 8px' }}>
        <span className="muted">Volume</span>
        <input
          type="range" min={0} max={300} step={5} value={pct}
          onChange={(e) => setUserVolume(userId, Number(e.target.value) / 100)}
          aria-label={`${name} volume`}
          style={{ flex: 1 }}
        />
        <span style={{ width: 40, textAlign: 'right' }}>{pct}%</span>
      </label>
      {canKick && (
        <button role="menuitem" type="button" className="danger" onClick={() => void kick()} style={{ textAlign: 'left' }}>
          Kick from call
        </button>
      )}
      {error && <p className="cw-error" role="alert" style={{ margin: '4px 8px' }}>{error}</p>}
    </div>
  );
}
