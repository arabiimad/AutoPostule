import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installErrorReporting } from './utils/errorReporting';
import { initClientMonitoring } from './utils/monitoring';
import { applyTheme, watchSystemTheme } from './utils/theme';

installErrorReporting();
initClientMonitoring();
applyTheme();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
