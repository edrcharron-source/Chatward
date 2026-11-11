import { useEffect, useState } from 'react';
import type { VaultDescriptor, VaultItem } from '@chatward/shared';
import { fetchVaultUrl } from './vault';

export interface AlbumCard {
  key: string;
  label: string;
  count: number;
  coverId?: string;
  /** Made by hand (stored on the server) rather than worked out from the photos. */
  manual?: boolean;
}

/** A row of album covers. Manual albums first, then the automatic ones. */
export default function AlbumStrip({ cards, active, onPick, onNew, newLabel, items, descs }: {
  cards: AlbumCard[];
  active: string | null;
  onPick: (key: string | null) => void;
  onNew?: () => void;
  newLabel: string;
  items: Record<string, VaultItem>;
  descs: Record<string, VaultDescriptor>;
}) {
  return (
    <div className="cw-vault-albums" role="group" aria-label="Albums">
      {onNew && (
        <button type="button" className="cw-vault-album cw-vault-album-new" onClick={onNew}>
          <span className="cw-vault-album-cover" aria-hidden="true">+</span>
          <span className="cw-vault-album-name">{newLabel}</span>
        </button>
      )}
      {cards.map((c) => (
        <button key={c.key} type="button" className={`cw-vault-album${active === c.key ? ' on' : ''}`} aria-pressed={active === c.key}
          onClick={() => onPick(active === c.key ? null : c.key)} title={c.label}>
          <Cover item={c.coverId ? items[c.coverId] : undefined} d={c.coverId ? descs[c.coverId] : undefined} />
          <span className="cw-vault-album-name">{c.manual ? '' : '✦ '}{c.label}</span>
          <span className="cw-vault-album-count muted">{c.count}</span>
        </button>
      ))}
    </div>
  );
}

function Cover({ item, d }: { item: VaultItem | undefined; d: VaultDescriptor | undefined }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item || !d) { setUrl(null); return; }
    let alive = true; let made: string | null = null;
    fetchVaultUrl(item, d, true).then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [item, d]);
  return <span className="cw-vault-album-cover">{url ? <img src={url} alt="" /> : null}</span>;
}
