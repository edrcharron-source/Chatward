import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './lcars/fonts';
import './lcars/lcars.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
