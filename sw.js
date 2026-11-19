/* Service Worker — 离线缓存壳（缓存优先，稳定不卡顿）*/
const CACHE = 'stock-ai-shell-v6';
const ASSETS = ['./', './index.html', './style.css', './db.js', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // 只清理本站点前缀的缓存，避免影响同域名下的其它站点
      .then(keys => Promise.all(keys.filter(k => k.startsWith('stock-ai-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 非 GET 请求、跨域请求（DeepSeek API 等）一律直连网络，不缓存
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 缓存优先：命中缓存直接返回（快、不卡），没有才走网络并回填缓存
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
