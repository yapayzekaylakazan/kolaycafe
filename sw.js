const CACHE_NAME = 'kolaycafe-v1';
const STATIC_ASSETS = [
  '/kolaycafe/',
  '/kolaycafe/index.html',
  '/kolaycafe/manifest.json'
];

// Kurulum
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Aktivasyon - eski cache temizle
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch - önce network, hata olursa cache
self.addEventListener('fetch', (event) => {
  // Supabase isteklerini cache'leme
  if (event.request.url.includes('supabase.co')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Başarılı yanıtı cache'e ekle
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network hatası - cache'den sun
        return caches.match(event.request).then((cached) => {
          return cached || caches.match('/kolaycafe/');
        });
      })
  );
});
