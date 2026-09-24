import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installErrorReporting } from './utils/errorReporting';
import { applyTheme, watchSystemTheme } from './utils/theme';

installErrorReporting();
applyTheme();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
