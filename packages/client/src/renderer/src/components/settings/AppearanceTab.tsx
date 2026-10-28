import { useSettings } from '../../state/settings';
import { playLcarsBeep } from '../../lcars/sound';
import { Section, Toggle } from './controls';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

const UI_STYLES = [
  { id: 'classic', label: 'Classic', hint: 'The default Chatward look.' },
  { id: 'lcars', label: 'LCARS', hint: 'Starship-console style: colored blocks, pill buttons, condensed type.' },
] as const;

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const uiStyle = useSettings((s) => s.uiStyle);
  const lcarsBeeps = useSettings((s) => s.lcarsBeeps);
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
      <Section title="Interface style">
        <div className="choice-group" role="radiogroup" aria-label="Interface style">
          {UI_STYLES.map((u) => (
            <label key={u.id} className="choice">
              <input type="radio" name="uiStyle" value={u.id} checked={uiStyle === u.id}
                onChange={() => set({ uiStyle: u.id })} />
              <span>{u.label}</span>
              <small className="muted">{u.hint}</small>
            </label>
          ))}
        </div>
        {uiStyle === 'lcars' && (
          <Toggle label="LCARS beeps" hint="A short console chirp when you press buttons. Off by default."
            checked={lcarsBeeps} onChange={(on) => { set({ lcarsBeeps: on }); if (on) playLcarsBeep(); }} />
        )}
      </Section>
    </>
  );
}
