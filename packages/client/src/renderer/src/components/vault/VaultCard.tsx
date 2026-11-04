import { useEffect, useState } from 'react';
import type { VaultRef } from '@chatward/shared';
import { fetchVaultUrl } from './vault';
import { Viewer } from './VaultView';

/** A Vault photo or video shown inside a chat message; click opens it full size. */
export default function VaultCard({ v }: { v: VaultRef }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true; let made: string | null = null;
    fetchVaultUrl({ id: v.itemId }, v, true)
      .then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setGone(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [v]);
  if (gone) return <div className="cv-muted">🖼️ This Vault item was removed.</div>;
  return (
    <>
      <button type="button" className="cw-vault-card" onClick={() => setOpen(true)} title={v.name}>
        {url ? <img src={url} alt={v.name} /> : <span className="muted">…</span>}
        {v.kind === 'video' && <span className="cw-vault-badge">▶</span>}
      </button>
      {open && <Viewer item={{ id: v.itemId }} d={v} canDelete={false} onDelete={() => {}} onClose={() => setOpen(false)} />}
    </>
  );
}
