/**
 * Visual skins, see docs/SKINS.md. A skin is a CSS pack in skins/<id>/skin.css whose rules all sit under
 * :root[data-skin='<id>'], plus one entry in SKINS. Only the id the settings store holds is active.
 */

export interface SkinInfo {
  id: string;
  label: string;
  /** Colour of the swatch in the Appearance tab. */
  swatch: string;
}

/** The installed skins, in the order the Appearance tab lists them. */
export const SKINS: SkinInfo[] = [
  { id: 'lebserver', label: 'Lebserver retro', swatch: '#f2a48c' },
  { id: 'retro-ascii', label: 'Retro ASCII', swatch: '#ffb000' },
];

// Packs load on first use, so a skin nobody picks costs nothing.
const packs = import.meta.glob('./*/skin.css');

let latest = 0;

/** Makes `id` the active skin. An id that is not installed, or whose pack fails to load, means no skin. A later call wins. */
export async function applySkin(id: string): Promise<void> {
  const run = ++latest;
  const skin = SKINS.find((s) => s.id === id);
  const load = skin && packs[`./${skin.id}/skin.css`];
  let ready = false;
  try {
    if (load) {
      await load();
      ready = true;
    }
  } catch (err) {
    console.warn('[skin] could not load', id, err);
  }
  if (run !== latest) return;
  if (skin && ready) document.documentElement.dataset.skin = skin.id;
  else delete document.documentElement.dataset.skin;
}
