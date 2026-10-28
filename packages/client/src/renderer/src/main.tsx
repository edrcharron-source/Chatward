import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { App } from './App';
import { PopoutPlayer } from './components/watchparty/PopoutPlayer';
import { isPopoutWindow } from './components/watchparty/popout';
import { restoreSession, useSession } from './state/session';
import { DEMO_URL } from './demo';

// The token comes from secureStore, so wait for it before the first request goes out.
// The page's connection rules are fixed when it loads. If the saved server is not the one they were set for, reload once.
// Demo mode talks to no server, so it asks for none.
async function start() {
  await restoreSession();
  const { serverUrl } = useSession.getState();
  try {
    if (await window.chatward.server.allow(serverUrl === DEMO_URL ? '' : serverUrl)) { location.reload(); return; }
  } catch (err) {
    console.warn('[server]', err);
  }
  createRoot(document.getElementById('root')!).render(isPopoutWindow() ? <PopoutPlayer /> : <App />);
}
void start();
