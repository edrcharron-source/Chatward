import { useSettings } from '../../state/settings';
import { SKINS, PLAIN_SKIN } from '../../skins';
import { Section, Toggle } from './controls';
import LayoutPreview from './LayoutPreview';

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
] as const;

const LAYOUTS = [
  { id: 'tabs', label: 'Tabs', hint: 'One text chat and one voice chat, picked from tabs along the top' },
  { id: 'classic', label: 'Classic', hint: 'The same tabs, stacked down a sidebar on the left with every button named' },
  { id: 'lcars', label: 'LCARS', hint: 'The LCARS frame: tabs down a rail on the left, call controls along the bottom' },
  { id: 'orbit', label: 'Orbit', hint: 'Clean sci-fi menus: tabs in a thin top bar over a line drawing' },
] as const;

export default function AppearanceTab() {
  const theme = useSettings((s) => s.theme);
  const skin = useSettings((s) => s.skin);
  const layout = useSettings((s) => s.layout);
  const confirmDeleteMessages = useSettings((s) => s.confirmDeleteMessages);
  const animatedBackgrounds = useSettings((s) => s.animatedBackgrounds);
  const seamlessWindow = useSettings((s) => s.seamlessWindow);
  // Only the desktop app on Windows and Linux has the see-through window (macOS keeps the usual one).
  const controls = window.chatward?.windowControls;
  const canSeamless = !!controls?.setShaped && controls.platform !== 'darwin';
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
        {/* Layout and skin are separate choices: picking one never changes the other. Each choice shows a small drawing
            of the layout in the skin that is on now. */}
        <div className="choice-group layouts" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <label key={l.id} className="choice" title={l.hint}>
              <LayoutPreview layout={l.id} />
              <span className="choice-label">
                <input type="radio" name="layout" value={l.id} checked={layout === l.id}
                  onChange={() => set({ layout: l.id })} />
                <span>{l.label}</span>
              </span>
            </label>
          ))}
        </div>
        {canSeamless && (
          <Toggle label="Seamless layout switching"
            hint="Switch to and from LCARS with no blink. Every layout then uses LCARS's see-through window, which has no window shadow, no Windows snapping when dragged to a screen edge, and the app's own thin resize edges."
            checked={seamlessWindow} onChange={(on) => set({ seamlessWindow: on })} />
        )}
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
              <small className="muted">Changes how the app looks, in any layout.</small>
            </span>
            <select aria-label="Skin" value={current.id} onChange={(e) => set({ skin: e.target.value })}>
              {choices.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <Toggle label="Animated backgrounds"
            hint="The Lebserver skin's ASCII art: the sign-in black hole, the Workouts ring and the voice meters. It holds still when your system is set to reduce motion."
            checked={animatedBackgrounds} onChange={(on) => set({ animatedBackgrounds: on })} />
        </Section>
      )}
    </>
  );
}

