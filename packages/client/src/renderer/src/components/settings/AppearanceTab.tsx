import { useSettings } from '../../state/settings';
import { SKINS, PLAIN_SKIN } from '../../skins';
import { Section } from './controls';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

const LAYOUTS = [
  { id: 'tabs', label: 'Tabs', hint: 'One text chat and one voice chat, picked from tabs along the top' },
  { id: 'classic', label: 'Classic', hint: 'Channel list on the left' },
] as const;

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const skin = useSettings((s) => s.skin);
  const layout = useSettings((s) => s.layout);
  const set = useSettings((s) => s.set);
  const choices = [PLAIN_SKIN, ...SKINS];
  // An unknown id counts as no skin, so it shows as Plain.
  const current = choices.find((s) => s.id === skin) ?? PLAIN_SKIN;
  return (
    <>
      <Section title="Theme">
        <div className="choice-group" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <label key={t.id} className="choice">
              <input type="radio" name="theme" value={t.id} checked={theme === t.id}
                onChange={() => set({ theme: t.id })} />
              <span className={`theme-swatch swatch-${t.id}`} aria-hidden />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title="Layout">
        <div className="choice-group" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <label key={l.id} className="choice" title={l.hint}>
              <input type="radio" name="layout" value={l.id} checked={layout === l.id}
                onChange={() => set({ layout: l.id })} />
              <span>{l.label}</span>
            </label>
          ))}
        </div>
      </Section>
      {SKINS.length > 0 && (
        <Section title="Skin">
          <label className="setting-row">
            <span className="setting-text">
              <span><span className="skin-swatch" style={{ background: current.swatch }} aria-hidden />{current.label}</span>
              <small className="muted">Changes how the app looks.</small>
            </span>
            <select aria-label="Skin" value={current.id} onChange={(e) => set({ skin: e.target.value })}>
              {choices.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </Section>
      )}
    </>
  );
}
