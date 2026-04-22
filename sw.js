// sw.js - 最小化 Service Worker，仅满足 PWA 安装条件，不缓存不拦截
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});
