import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary, { reloadOnceForStaleChunk } from './ErrorBoundary.jsx';
import './index.css';

// Vite fires this when a lazy chunk's preload fails (typically a stale tab after a deploy).
window.addEventListener('vite:preloadError', (e) => {
  if (reloadOnceForStaleChunk()) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
