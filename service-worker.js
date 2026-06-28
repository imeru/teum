/* 틈(TEUM) service worker — 오프라인 캐시 */
const CACHE = 'teum-v57';
const ASSETS = ['./','./index.html','./privacy.html','./app.js','./constants.js','./helpers.js','./logic.js','./supabase.js','./styles.css','./manifest.json',
  './vendor/quill.js','./vendor/quill.snow.css',
  './icons/icon-192.png','./icons/icon-512.png','./icons/logo-symbol-tight.svg',
  './icons/teum-logo-horizontal.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 외부(Supabase/CDN)는 항상 네트워크
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() => cached))
  );
});
