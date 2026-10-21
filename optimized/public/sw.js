/**
 * AI 七嫂 · Service Worker
 *
 * 目的：第二次打开（以及断网时）直接出界面，不用再等服务器。
 * - 导航及未版本化主脚本：network-first，4 秒后回退缓存
 * - 其余静态资源：cache-first
 * - /api/：完全不碰，避免把回答缓存住
 *
 * 发版时把 VERSION 改掉即可强制刷新缓存。
 */
var VERSION = 'qisao-v20261021-2';

var PRECACHE = [
    '/',
    '/static/js/app.js',
    '/static/js/app.js?v=20261021-2',
    '/static/js/markdown.mjs',
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
                return Promise.all(keys.filter(function (key) { return key.indexOf('qisao-') === 0 && key !== VERSION; })
                    .map(function (key) { return caches.delete(key); }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'QISAO_VERSION') return;
    var reply = { type: 'QISAO_VERSION', version: VERSION };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
});

function isNavigation(request) {
    if (request.mode === 'navigate') return true;
    var accept = request.headers.get('accept') || '';
    return accept.indexOf('text/html') !== -1;
}

async function networkFirst(request, navigation) {
    var cache = await caches.open(VERSION);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 4000);
    try {
        var response = await fetch(request, { cache: 'no-cache', signal: controller.signal });
        if (response.ok && response.type === 'basic') {
            await cache.put(request, response.clone()).catch(function () {});
        }
        return response;
    } catch (error) {
    } finally {
        clearTimeout(timer);
    }

    var cached = await cache.match(request);
    if (cached) return cached;
    if (!navigation) return new Response('', { status: 503, statusText: 'Service Unavailable' });

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
    if (url.pathname.indexOf('/static/gen/') === 0) return;
    if (url.pathname.indexOf('/api/') === 0) return;
    if (url.pathname === '/release.json') return;

    if (isNavigation(request)) {
        event.respondWith(networkFirst(request, true));
        return;
    }

    if (url.pathname === '/static/js/app.js' && !url.search) {
        event.respondWith(networkFirst(request, false));
        return;
    }

    event.respondWith(cacheFirst(request));
});
