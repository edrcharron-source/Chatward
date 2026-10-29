import { buildLabel } from '../buildInfo';
import { useSession } from '../state/session';
import { DEMO_URL, exitDemo } from './index';
import './demo.css';

export default function DemoBanner() {
  const demo = useSession((s) => s.serverUrl === DEMO_URL);
  if (!demo) return null;
  return (
    <div className="cw-demo-banner" role="status">
      <span>Demo mode. Nothing is sent anywhere.</span>
      {buildLabel() && <span className="cw-demo-build">{buildLabel()}</span>}
      <button type="button" onClick={exitDemo}>Exit demo</button>
    </div>
  );
}
