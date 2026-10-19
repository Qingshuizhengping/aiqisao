/**
 * AI 七嫂 · Service Worker
 *
 * 目的：第二次打开（以及断网时）直接出界面，不用再等服务器。
 * - 导航请求：stale-while-revalidate —— 先用缓存秒开，同时后台取新版
 * - 静态资源：cache-first
 * - /api/：完全不碰，避免把回答缓存住
 *
 * 发版时把 VERSION 改掉即可强制刷新缓存。
 */
var VERSION = 'qisao-v1';

var PRECACHE = [
    '/',
    '/static/js/app.js',
    '/static/js/lightfield.js',
    '/static/img/avatar-192.webp',
    '/static/img/avatar-96.webp',
    '/static/img/icon-192.png',
    '/manifest.json'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(VERSION)
            .then(function (cache) {
                // 单个资源失败不影响整体安装
                return Promise.all(PRECACHE.map(function (url) {
                    return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
                }));
            })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.filter(function (key) { return key !== VERSION; })
                    .map(function (key) { return caches.delete(key); }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

function isNavigation(request) {
    if (request.mode === 'navigate') return true;
    var accept = request.headers.get('accept') || '';
    return accept.indexOf('text/html') !== -1;
}

async function staleWhileRevalidate(request) {
    var cache = await caches.open(VERSION);
    var cached = await cache.match(request);

    var network = fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
        }
        return response;
    }).catch(function () { return null; });

    if (cached) {
        network.catch(function () {});
        return cached;
    }

    var response = await network;
    if (response) return response;

    var shell = await cache.match('/');
    return shell || new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>离线</title>' +
        '<body style="font:15px/1.8 -apple-system,PingFang SC,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#5b6474">' +
        '<p>当前处于离线状态，联网后重试。</p></body>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

async function cacheFirst(request) {
    var cache = await caches.open(VERSION);
    var cached = await cache.match(request);
    if (cached) return cached;

    var response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf('/api/') === 0) return;

    if (isNavigation(request)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});
