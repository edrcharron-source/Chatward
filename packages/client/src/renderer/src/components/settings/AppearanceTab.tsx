import { useSettings } from '../../state/settings';
import { Section } from './controls';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  return (
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
  );
}
