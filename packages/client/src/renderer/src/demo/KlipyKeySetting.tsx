// Demo-only setting: paste a KLIPY key so GIF search and trending are live. The key lives in the secure store.
import { useEffect, useState, type ReactElement } from 'react';
import { Section } from '../components/settings/controls';

export const KLIPY_KEY_STORE = 'klipyApiKey';

export function KlipyKeySetting(): ReactElement {
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.chatward.secureStore.get(KLIPY_KEY_STORE).then((v) => setSaved(Boolean(v))).catch(() => setSaved(false));
  }, []);

  async function save(value: string) {
    setError(null);
    try {
      const trimmed = value.trim();
      await window.chatward.secureStore.set(KLIPY_KEY_STORE, trimmed);
      setSaved(trimmed !== '');
      setDraft('');
    } catch {
      setError('Could not save the key.');
    }
  }

  return (
    <Section title="Demo internet">
      <p className="muted demo-key-hint">
        Paste a KLIPY API key to search and browse real GIFs in demo. Without one, the GIF picker shows placeholder tiles.
        The key is encrypted on this PC and sent only to KLIPY.
      </p>
      <div className="demo-key-row">
        <input
          type="password"
          value={draft}
          placeholder={saved ? 'Key saved. Paste a new one to replace it' : 'KLIPY API key'}
          autoComplete="off"
          spellCheck={false}
          aria-label="KLIPY API key"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" disabled={!draft.trim()} onClick={() => void save(draft)}>Save key</button>
        {saved && <button type="button" onClick={() => void save('')}>Remove key</button>}
      </div>
      {error && <p className="demo-key-error" role="alert">{error}</p>}
    </Section>
  );
}
