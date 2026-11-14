import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';

// Un fichier lâché hors de la zone prévue ne doit pas ouvrir une page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
