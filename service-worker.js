const CACHE_PREFIX = 'lcms-flashcards-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const SHELL_FILES = [
  './',
  './index.html',
  './flashcards.html',
  './flashcards.css?v=20261022-iq-streak1',
  './flashcards.js?v=20261022-iq-streak2',
];

function scopedUrl(path) {
  return new URL(path, self.registration.scope).href;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_FILES.map(async path => {
      const request = new Request(scopedUrl(path), { cache: 'reload' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(request, { signal: controller.signal });
        if (response.ok) await cache.put(request, response);
      } catch {
        // Keep installation usable on a slow connection; resources cache as they load later.
      } finally {
        clearTimeout(timeout);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const oldCaches = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
    await Promise.all(oldCaches.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.destination === 'image') {
    event.respondWith(loadImage(request));
    return;
  }

  if (
    request.destination === 'document' ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    /\/questions\.json$/i.test(url.pathname)
  ) {
    event.respondWith(loadAppResource(request));
  }
});

async function loadImage(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(request);
      if (response.ok) {
        try { await cache.put(request, response.clone()); } catch {}
        return response;
      }
      if (response.status < 500) return response;
      lastError = new Error(`Image request failed (${response.status})`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
  }

  const fallback = await cache.match(request);
  if (fallback) return fallback;
  throw lastError || new Error('Image request failed');
}

async function loadAppResource(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) {
      try { await cache.put(request, response.clone()); } catch {}
      return response;
    }
    return (await cache.match(request)) || response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('This app resource is not available offline.');
  } finally {
    clearTimeout(timeout);
  }
}
