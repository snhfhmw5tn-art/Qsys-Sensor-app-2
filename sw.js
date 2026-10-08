const CACHE = 'qsys-motion-v2';
const FILES = [
  '/',
  '/client/style.css',
  '/client/app.js',
  '/client/pipeline.js',
  '/client/sources.js',
  '/client/network.js',
  '/client/maps.js',
  '/client/benchmark.js',
  '/shared/config.js',
  '/vendor/geographiclib-geodesic.min.js',
];
self.addEventListener('install', (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('fetch', (e) => {
  if (
    e.request.method !== 'GET' ||
    new URL(e.request.url).origin !== location.origin ||
    new URL(e.request.url).pathname.startsWith('/api/')
  )
    return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
