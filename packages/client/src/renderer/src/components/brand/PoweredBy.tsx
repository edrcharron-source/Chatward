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

// Stacked server units inside a hexagon frame. Strokes use currentColor so the mark follows the theme accent.
function LebserverMark() {
  return (
    <svg className="cw-powered-mark" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M12 1.8 20.8 6.9v10.2L12 22.2 3.2 17.1V6.9Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="7.5" y="7.6" width="9" height="2.6" rx=".8" fill="currentColor" opacity=".9" />
      <rect x="7.5" y="10.7" width="9" height="2.6" rx=".8" fill="currentColor" opacity=".65" />
      <rect x="7.5" y="13.8" width="9" height="2.6" rx=".8" fill="currentColor" opacity=".4" />
      <circle className="cw-powered-led" cx="15" cy="8.9" r=".7" />
    </svg>
  );
}

export default function PoweredBy() {
  const show = useSession((s) => isLebserver(s.serverUrl));
  if (!show) return null;
  return (
    <footer className="cw-powered" aria-label="Powered by Lebserver">
      <span className="cw-powered-tick" aria-hidden="true" />
      <span className="cw-powered-label">Powered by</span>
      <LebserverMark />
      <span className="cw-powered-name">Lebserver</span>
      <span className="cw-powered-tick" aria-hidden="true" />
    </footer>
  );
}
