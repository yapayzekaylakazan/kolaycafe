// KolayCafe SW v20260309230937
// Bu dosya her deploy'da değişerek CDN cache'ini temizler

const CACHE_VERSION = 'v20260309230937';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: Her zaman sunucudan al, cache kullanma
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/app/index.html') || 
      e.request.url.includes('/app/mutfak.html')) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'})
        .catch(() => caches.match(e.request))
    );
  }
});
