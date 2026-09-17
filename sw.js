const CACHE_NAME = 'calldaddy-cache-v5';
const urlsToCache = ['/', '/index.html', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/admin.html'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => clients.claim()));
});

self.addEventListener('fetch', event => {
    const url = event.request.url;
    if (url.includes('/api/') || url.includes('firebase') || url.includes('socket.io') || url.includes('googleapis') || url.includes('gstatic.com')) return;
    event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)).catch(() => fetch(event.request)));
});
