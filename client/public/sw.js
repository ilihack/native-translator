const CACHE_NAME = 'native-translator-v7.0.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app',
  '/app.html',
  '/manifest.json',
  '/favicon.png'
];

// Aggressive caching for Vite-generated assets (immutable hashed files)
const IMMUTABLE_PATTERNS = [
  /^\/assets\/.+\.(js|css|woff2?)$/
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (event.request.method !== 'GET') return;
  
  // Skip WebSocket and Gemini API
  if (url.protocol === 'wss:' || url.hostname.includes('generativelanguage.googleapis.com')) {
    return;
  }

  // Check if this is an immutable asset (hashed Vite bundles)
  const isImmutable = IMMUTABLE_PATTERNS.some(pattern => pattern.test(url.pathname));

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Immutable assets: serve from cache immediately, no revalidation
        if (isImmutable) {
          return cachedResponse;
        }
        // Other cached assets: serve from cache, update in background.
        // Only cache same-origin responses to prevent cross-origin cache poisoning.
        event.waitUntil(
          fetch(event.request).then((response) => {
            if (response.ok && response.type !== 'opaque' && url.origin === self.location.origin) {
              return caches.open(CACHE_NAME).then((cache) => {
                return cache.put(event.request, response);
              });
            }
          }).catch(() => {})
        );
        return cachedResponse;
      }

      // Not in cache: fetch and cache
      return fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          // /app routes fall back to /app.html; all others fall back to /
          const fallback = url.pathname.startsWith('/app') ? '/app' : '/';
          return caches.match(fallback);
        }
      });
    })
  );
});

self.addEventListener('message', (event) => {
  // event.source can be null for messages not originating from a controlled client
  if (!event.source) return;

  if (event.data === 'skipWaiting' || (event.data && event.data.action === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
  if (event.data === 'clearCache') {
    caches.keys().then((cacheNames) => {
      return Promise.all(cacheNames.map((name) => caches.delete(name)));
    }).then(() => {
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage('cacheCleared'));
      });
    });
  }
  if (event.data === 'GET_VERSION' || (event.data && event.data.action === 'GET_VERSION')) {
    const version = CACHE_NAME.replace('native-translator-v', '');
    event.source.postMessage({ type: 'VERSION', version: version });
  }
});
