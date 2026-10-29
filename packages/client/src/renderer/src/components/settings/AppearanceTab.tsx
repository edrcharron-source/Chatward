import { useSettings } from '../../state/settings';
import { SKINS } from '../../skins';
import { Section, Toggle } from './controls';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const skin = useSettings((s) => s.skin);
  const set = useSettings((s) => s.set);
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
      {SKINS.length > 0 && (
        <Section title="Skins">
          {SKINS.map((s) => (
            <Toggle key={s.id}
              label={<><span className="skin-swatch" style={{ background: s.swatch }} aria-hidden />{s.label}</>}
              checked={skin === s.id}
              onChange={(on) => set({ skin: on ? s.id : '' })} />
          ))}
        </Section>
      )}
    </>
  );
}
