import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { App } from './App';
import { PopoutPlayer } from './components/watchparty/PopoutPlayer';
import { isPopoutWindow } from './components/watchparty/popout';
createRoot(document.getElementById('root')!).render(isPopoutWindow() ? <PopoutPlayer /> : <App />);
