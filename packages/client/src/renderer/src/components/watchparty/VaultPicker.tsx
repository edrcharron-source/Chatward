// "From Vault": lists the server's Vault videos so one can be queued in Watch together.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ServerFrame, VaultDescriptor, VaultItem } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { fetchVaultUrl, openDescriptor, type VaultPage } from '../vault/vault';

export interface VaultVideo { item: VaultItem; d: VaultDescriptor }

const length = (sec?: number) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '');

function Thumb({ v }: { v: VaultVideo }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let made: string | null = null;
    fetchVaultUrl(v.item, v.d, true).then((u) => { if (live) { made = u; setSrc(u); } else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [v.item.id]);
  return src ? <img className="watch-party-thumb" src={src} alt="" draggable={false} /> : <span className="watch-party-thumb empty" aria-hidden="true">▶</span>;
}

/** Only videos are listed; photos in the Vault are skipped. Older pages load on demand. */
export function VaultPicker({ serverId, uploading, onPick, onUpload, onClose }: {
  serverId: string;
  uploading: boolean;
  onPick: (v: VaultVideo) => void;
  onUpload: (files: File[]) => void;
  onClose: () => void;
}): ReactElement {
  const [videos, setVideos] = useState<VaultVideo[]>([]);
  const [oldest, setOldest] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const open = async (items: VaultItem[]): Promise<VaultVideo[]> => {
    const opened = await Promise.all(items.map(async (item) => ({ item, d: await openDescriptor(item).catch(() => null) })));
    return opened.filter((v): v is VaultVideo => v.d?.kind === 'video');
  };

  const load = async (before: number | null) => {
    setLoading(true);
    try {
      const page = await api.get<VaultPage>(`/api/servers/${serverId}/vault${before ? `?before=${before}` : ''}`);
      const found = await open(page.items);
      setVideos((cur) => [...cur, ...found.filter((v) => !cur.some((c) => c.item.id === v.item.id))]);
      setOldest(page.items.length ? page.items[page.items.length - 1].createdAt : before);
      setHasMore(page.hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setVideos([]);
    void load(null);
    return onFrame((f: ServerFrame) => {
      if (f.t === 'vault.new' && f.item.serverId === serverId) {
        void open([f.item]).then((found) => setVideos((cur) => [...found.filter((v) => !cur.some((c) => c.item.id === v.item.id)), ...cur]));
      } else if (f.t === 'vault.delete' && f.serverId === serverId) {
        setVideos((cur) => cur.filter((v) => v.item.id !== f.itemId));
      }
    });
  }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="watch-party-vault" role="dialog" aria-label="Pick a video from the Vault">
      <div className="watch-party-vault-head">
        <span>Videos in the Vault</span>
        <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>Upload a video</button>
        <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={(e) => { onUpload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {error && <p role="alert" className="watch-party-error">{error}</p>}
      {!loading && !error && !videos.length && <p className="watch-party-hint">No videos in the Vault yet. Upload one here, or drop a video file on the link box.</p>}
      {videos.length > 0 && (
        <ul className="watch-party-vault-list">
          {videos.map((v) => (
            <li key={v.item.id}>
              <button type="button" title={`Queue ${v.d.name}`} onClick={() => onPick(v)}>
                <Thumb v={v} />
                <span className="watch-party-vault-name">{v.d.name}</span>
                <span className="watch-party-hint">{length(v.d.durationSec)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="watch-party-hint">Loading…</p>}
      {hasMore && !loading && <button type="button" onClick={() => void load(oldest)}>Load older</button>}
    </div>
  );
}
