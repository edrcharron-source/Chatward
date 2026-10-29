import { useState } from 'react';
import { addLibraryGif, addLibraryGifFromUrl } from '../../state/gifLibrary';
import GifDetailsDialog from './GifDetailsDialog';
import './gifs.css';

/** Where the GIF's bytes come from: a KLIPY address (the server downloads it) or a decrypted attachment's object URL. */
export type GifSource = { kind: 'klipy'; url: string } | { kind: 'local'; url: string };

/** Hover button on a GIF in chat that copies it into the server's GIF library. */
export default function SaveGifButton({ serverId, source, defaultName }: { serverId: string; source: GifSource; defaultName: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (name: string, tags: string[]) => {
    if (source.kind === 'klipy') await addLibraryGifFromUrl(serverId, source.url, name, tags);
    else await addLibraryGif(serverId, await (await fetch(source.url)).arrayBuffer(), name, tags);
    setSaved(true);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="gif-save-btn"
        disabled={saved}
        title="Save to server GIFs"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        {saved ? 'Saved ✓' : 'Save to server GIFs'}
      </button>
      {open && (
        <GifDetailsDialog
          title="Save to server GIFs"
          preview={<img src={source.url} alt="" className="gif-dialog-img" referrerPolicy="no-referrer" />}
          initialName={defaultName}
          submitLabel="Save"
          note="Everyone on this server will be able to use it. Saved GIFs aren't end-to-end encrypted, so don't save anything private."
          onSubmit={save}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
