import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import Tasks from './Tasks.jsx';
import Notifier from './Notifier.jsx';

// The same bundle drives the pop-up window, which Electron loads as index.html#notifier.
const notifier = location.hash === '#notifier' && !!window.slab;
if (notifier) {
  for (const el of [document.documentElement, document.body]) el.style.overflow = 'hidden';
}
createRoot(document.getElementById('root')).render(notifier ? <Notifier /> : <Tasks />);
