import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { App } from './App';
import { PopoutPlayer } from './components/watchparty/PopoutPlayer';
import { isPopoutWindow } from './components/watchparty/popout';
import { restoreSession } from './state/session';

// The token comes from secureStore, so wait for it before the first request goes out.
void restoreSession().then(() => {
  createRoot(document.getElementById('root')!).render(isPopoutWindow() ? <PopoutPlayer /> : <App />);
});
