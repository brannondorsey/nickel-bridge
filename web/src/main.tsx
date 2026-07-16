import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// self-hosted fonts: Poiret One = wordmark, Crimson Pro = body,
// Besley = labels/numerals/buttons, Josefin Sans = stamps/postmarks.
// Besley ships as a variable font: one file per style covers every weight the
// UI uses (600/700/800 + italics) instead of five static-instance files.
// Note Besley's tabular figures are broken at bold weights in every published
// build — see the `.num` rule in style.css before touching numeral styling.
import '@fontsource/poiret-one/latin-400.css';
import '@fontsource/crimson-pro/latin-400.css';
import '@fontsource/crimson-pro/latin-600.css';
import '@fontsource-variable/besley/wght.css';
import '@fontsource-variable/besley/wght-italic.css';
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
