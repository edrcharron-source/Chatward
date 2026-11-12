import { useSession } from '../../state/session';
import { usePhone } from '../../web/usePhone';
import './brand.css';

// Shown only when the app is pointed at a lebserver.com server, so other Chatward hosts stay unbranded.
export function isLebserver(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === 'lebserver.com' || host.endsWith('.lebserver.com');
  } catch {
    return false;
  }
}

/** On a phone the strip sits in the "You" sheet instead (`force`), so it never takes room under the tab bar. */
export default function PoweredBy({ force = false }: { force?: boolean } = {}) {
  const show = useSession((s) => isLebserver(s.serverUrl));
  const phone = usePhone();
  if (!show || (phone && !force)) return null;
  return (
    <footer className="cw-powered" aria-label="Powered by Lebserver">
      <span className="cw-powered-cap" aria-hidden="true" />
      <span className="cw-powered-label">powered by //</span>
      <span className="cw-powered-chip">
        <span className="cw-powered-dot" aria-hidden="true" />
        <span className="cw-powered-name">LEBSERVER</span>
      </span>
      <span className="cw-powered-cap" aria-hidden="true" />
    </footer>
  );
}
