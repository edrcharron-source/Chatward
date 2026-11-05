import { useSettings } from '../../state/settings';
import { SKINS, PLAIN_SKIN } from '../../skins';
import { Section, Toggle } from './controls';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

const LAYOUTS = [
  { id: 'tabs', label: 'Tabs', hint: 'One text chat and one voice chat, picked from tabs along the top' },
  { id: 'classic', label: 'Classic', hint: 'Channel list on the left' },
  { id: 'lcars', label: 'LCARS', hint: 'The LCARS frame: tabs down a rail on the left, call controls along the bottom. Comes with the LCARS skin' },
  { id: 'orbit', label: 'Orbit', hint: 'Clean sci-fi menus: tabs in a thin top bar over a line drawing. Comes with the Orbit skin' },
] as const;

type Layout = (typeof LAYOUTS)[number]['id'];

/** A layout that comes with a skin brings that skin along. */
const layoutChoice = (id: Layout): { layout: Layout; skin?: string } => {
  const skin = SKINS.find((s) => s.layout === id);
  return skin ? { layout: id, skin: skin.id } : { layout: id };
};

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const skin = useSettings((s) => s.skin);
  const layout = useSettings((s) => s.layout);
  const confirmDeleteMessages = useSettings((s) => s.confirmDeleteMessages);
  const animatedBackgrounds = useSettings((s) => s.animatedBackgrounds);
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
                onChange={() => set(layoutChoice(l.id))} />
              <span>{l.label}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title="Confirmations">
        <Toggle label="Ask before deleting a message"
          hint="Turn off to delete a message straight away. Turn on again to be asked each time."
          checked={confirmDeleteMessages} onChange={(on) => set({ confirmDeleteMessages: on })} />
      </Section>
      {SKINS.length > 0 && (
        <Section title="Skin">
          <label className="setting-row">
            <span className="setting-text">
              <span><span className="skin-swatch" style={{ background: current.swatch }} aria-hidden />{current.label}</span>
              <small className="muted">Changes how the app looks.</small>
            </span>
            <select aria-label="Skin" value={current.id} onChange={(e) => set(skinChoice(e.target.value, layout))}>
              {choices.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <Toggle label="Animated backgrounds"
            hint="The Lebserver skin's black hole on the sign-in screen. It holds still when your system is set to reduce motion."
            checked={animatedBackgrounds} onChange={(on) => set({ animatedBackgrounds: on })} />
        </Section>
      )}
    </>
  );
}

/**
 * A skin that comes with its own layout brings it along, and leaving that skin goes back to the Tabs layout, so a skin's
 * frame is never left on without its look. Any other pick leaves the layout as it is.
 */
function skinChoice(id: string, layout: string): { skin: string; layout?: Layout } {
  const next = SKINS.find((s) => s.id === id);
  if (next?.layout) return { skin: id, layout: next.layout };
  if (SKINS.some((s) => s.layout === layout)) return { skin: id, layout: 'tabs' };
  return { skin: id };
}
