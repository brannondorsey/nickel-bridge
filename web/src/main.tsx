import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// self-hosted fonts (latin subsets only): Poiret One = wordmark, Crimson Pro =
// body, Besley = labels/numerals/buttons, Josefin Sans = stamps/postmarks
import '@fontsource/poiret-one/latin-400.css';
import '@fontsource/crimson-pro/latin-400.css';
import '@fontsource/crimson-pro/latin-600.css';
import '@fontsource/besley/latin-400.css';
import '@fontsource/besley/latin-400-italic.css';
import '@fontsource/besley/latin-600.css';
import '@fontsource/besley/latin-700.css';
import '@fontsource/besley/latin-800.css';
import '@fontsource/josefin-sans/latin-400.css';
import '@fontsource/josefin-sans/latin-600.css';
import App from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
