import { useSettings } from '../../state/settings';
import { Section, Toggle } from './controls';

export default function PrivacyTab() {
  const linkPreviews = useSettings((s) => s.linkPreviews);
  const autoLoadEmbeds = useSettings((s) => s.autoLoadEmbeds);
  const set = useSettings((s) => s.set);
  return (
    <Section title="Links and embeds">
      <Toggle label="Link previews" hint="Your app fetches the page for a link you send and attaches a preview. Viewers never fetch it."
        checked={linkPreviews} onChange={(on) => set({ linkPreviews: on })} />
      <Toggle label="Load embeds automatically" hint="YouTube and X embeds load without a click. Off means you click to load each one."
        checked={autoLoadEmbeds} onChange={(on) => set({ autoLoadEmbeds: on })} />
    </Section>
  );
}
