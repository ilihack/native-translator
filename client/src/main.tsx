/**
 * Application entry point mounting the React root with ErrorBoundary wrapper
 * and registering the PWA service worker for offline caching and updates.
 * @inputs DOM element #root, service worker at /sw.js
 * @exports None (side-effect: mounts React app)
 */

import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import { logger } from './utils/logger';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// Register Service Worker for PWA and set up reliable update delivery
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        // Periodic check every 60 minutes — browser default is 24h which is too slow
        const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
        const intervalId = setInterval(() => {
          registration.update().catch(() => {});
        }, UPDATE_INTERVAL_MS);

        // Check for updates whenever the user returns to the app after being away
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
            registration.update().catch(() => {});
          }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Check for updates when the app regains network connectivity
        const onOnline = () => { registration.update().catch(() => {}); };
        window.addEventListener('online', onOnline);

        registration.addEventListener('updatefound', () => {
          logger.general.info('SW: new version found, installing…');
        });

        // Clean up the polling interval and listeners when the page is torn down.
        // `pagehide` is preferred over `beforeunload` because it fires for both
        // normal navigation and bfcache entry, keeping the interval from leaking
        // if the browser puts the page in the back/forward cache.
        const cleanup = () => {
          clearInterval(intervalId);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          window.removeEventListener('online', onOnline);
        };
        window.addEventListener('pagehide', cleanup, { once: true });
      })
      .catch(err => {
        logger.general.warn('SW registration failed:', err);
      });
  });
}
