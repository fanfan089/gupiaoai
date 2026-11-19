/* Service Worker — 离线缓存壳（网络优先，保证更新即时生效）*/
const CACHE = 'stock-ai-shell-v1';
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
      .then(keys => Promise.all(keys.filter(k => k.startsWith('stock-ai-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => { clients.forEach(c => { try { c.postMessage({ type: 'NEW_VERSION' }); } catch (_) {} }); })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 非 GET 请求、跨域请求（DeepSeek API 等）一律直连网络，不缓存
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 网络优先：先取线上最新版，成功就更新缓存；离线失败才回退到缓存
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
