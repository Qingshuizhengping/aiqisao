const CACHE = 'weizhiyu-internal-shell-v1';
const SHELL = ['/', '/assets/app.js', '/assets/style.css', '/manifest.webmanifest', '/static/img/avatar-192.png', '/static/img/icon-192.png', '/static/img/icon-512.png', '/static/img/apple-touch-icon.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('weizhiyu-internal-shell-') && name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
    if (event.request.mode === 'navigate') {
        event.respondWith(fetch(event.request).catch(() => caches.match('/')));
        return;
    }
    if (!SHELL.includes(url.pathname)) return;
    event.respondWith(fetch(event.request).then(response => {
        if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy)));
        }
        return response;
    }).catch(() => caches.match(url.pathname)));
});
