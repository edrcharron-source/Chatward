import { useSession } from '../../state/session';
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

export default function PoweredBy() {
  const show = useSession((s) => isLebserver(s.serverUrl));
  if (!show) return null;
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
