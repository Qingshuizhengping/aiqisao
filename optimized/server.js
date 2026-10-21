// AI 七嫂 · 阿里云部署版服务端
// 相比原 server.js 的三处改动：
//   1. 预压缩资源直出（public 下的 .br/.gz 由 build.py 生成），不再每次现压
//   2. 按文件类型下发缓存策略，静态资源可被浏览器/CDN 复用
//   3. 静态文件关闭 etag 二次读盘，改用 mtime + 长的 stalez 窗口
import express from 'express';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, MODEL, MAX_TOKENS, TEMPERATURE, buildMessages, textToHtml, getApiKey, IMAGE_MODEL, getImageApiKey } from './api/_config.js';
import { renderMarkdown } from './public/static/js/markdown.mjs';
import { generateImage } from './api/image_gen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 极简 .env 加载：容器/PM2 已注入的变量优先，这里只做本机补位
function loadDotEnv() {
    let raw;
    try { raw = readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch { return; }
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadDotEnv();

const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_VERSION = 'qisao-v20261019-3';
const MODEL_REQUEST_OPTIONS = MODEL === 'zai-org/GLM-5.3-Flash' ? { reasoning_effort: 'low' } : {};

function renderClientAnswer(content, clientVersion) {
    const html = renderMarkdown(content);
    if (clientVersion === CLIENT_VERSION) return html;
    return html + '<p class="client-update"><a href="/?v=20261019-3">启用新版实时排版（请先保存草稿）</a><br><small>对话记录保留，无需重装。</small></p>';
}

app.disable('x-powered-by');
// 生图会带参考图 base64，1mb 不够
app.use(express.json({ limit: '16mb' }));

// ---------- 静态资源：预压缩 + 分类缓存 ----------
// 顺序即优先级：sw.js / manifest 必须排在 .js 之前，否则会被当成普通脚本缓存一天，
// 导致发版后老用户迟迟拿不到新版本。
const CACHE_RULES = [
    { test: /manifest\.json$/i, value: 'public, max-age=0, must-revalidate' },
    { test: /[/\\]sw\.js$/i, value: 'public, max-age=0, must-revalidate' },
    { test: /[/\\]app\.js$/i, value: 'public, max-age=0, must-revalidate' },
    // 生成图会被 GC 删除，缓存时间压到 1 小时
    { test: /[/\\]static[/\\]gen[/\\]/i, value: 'public, max-age=3600' },
    { test: /\.(?:png|webp|jpg|jpeg|svg|ico)$/i, value: 'public, max-age=2592000' },
    { test: /\.(?:css|js|mjs)$/i, value: 'public, max-age=86400, stale-while-revalidate=604800' },
];

function cacheFor(filePath) {
    for (const rule of CACHE_RULES) if (rule.test.test(filePath)) return rule.value;
    return 'public, max-age=0, must-revalidate';
}

app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let rel;
    try {
        rel = decodeURIComponent(req.path);
    } catch {
        return res.status(400).end();
    }
    if (rel.split(/[/\\]/).some(segment => segment.startsWith('.'))) return res.status(404).end();
    if (rel === '/' || rel === '') rel = '/index.html';
    // 独立生图页的短地址
    if (rel === '/image' || rel === '/image/') rel = '/image.html';

    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return res.status(403).end();

    let stat;
    try {
        stat = statSync(filePath);
        if (!stat.isFile()) return next();
    } catch {
        // 前端是单页应用，未命中的路径回落到 index.html
        if (!path.extname(rel)) return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
        return res.status(404).end();
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.apk': 'application/vnd.android.package-archive',
    }[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cacheFor(filePath));
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    // 条件请求直接 304，省掉整个 body
    const inm = req.headers['if-modified-since'];
    if (inm && new Date(inm).getTime() >= Math.floor(stat.mtime.getTime() / 1000) * 1000) {
        return res.status(304).end();
    }

    const accept = req.headers['accept-encoding'] || '';
    const candidates = [];
    if (/\bbr\b/.test(accept)) candidates.push(['br', '.br', 'br']);
    if (/\bgzip\b/.test(accept)) candidates.push(['gzip', '.gz', 'gzip']);

    for (const [, suffix, encoding] of candidates) {
        try {
            const compressed = statSync(filePath + suffix);
            res.setHeader('Content-Encoding', encoding);
            res.setHeader('Content-Length', compressed.size);
            return createReadStream(filePath + suffix).pipe(res);
        } catch { /* 没有预压缩文件就继续 */ }
    }

    res.setHeader('Content-Length', stat.size);
    return createReadStream(filePath).pipe(res);
});

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    model: MODEL,
    imageModel: IMAGE_MODEL,
    imageReady: Boolean(getImageApiKey()),
}));

// ---------- 生图（独立入口 /image 使用） ----------
// 生图按次计费，公网必须挡一层：每 IP 每分钟 5 次、每小时 30 次
const IMAGE_LIMIT_MINUTE = 5;
const IMAGE_LIMIT_HOUR = 30;
const imageHits = new Map();

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function allowImage(ip) {
    const now = Date.now();
    const rec = imageHits.get(ip) || { minute: [], hour: [] };
    rec.minute = rec.minute.filter((t) => now - t < 60000);
    rec.hour = rec.hour.filter((t) => now - t < 3600000);
    if (rec.minute.length >= IMAGE_LIMIT_MINUTE || rec.hour.length >= IMAGE_LIMIT_HOUR) {
        imageHits.set(ip, rec);
        return false;
    }
    rec.minute.push(now);
    rec.hour.push(now);
    imageHits.set(ip, rec);
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of imageHits) {
        if (!rec.hour.some((t) => now - t < 3600000)) imageHits.delete(ip);
    }
}, 600000).unref();

app.post('/api/image', async (req, res) => {
    const apiKey = getImageApiKey();
    if (!apiKey) return res.status(500).json({ status: 'error', error: '服务端未配置 HUNYUAN_API_KEY，生图不可用' });
    if (!allowImage(clientIp(req))) {
        return res.status(429).json({ status: 'error', error: '生成太频繁了，歇一会儿再来（每分钟 5 张、每小时 30 张）' });
    }
    try {
        const result = await generateImage(req.body || {}, apiKey);
        return res.json({ status: 'ok', url: result.url, revisedPrompt: result.revisedPrompt, tokens: result.tokens });
    } catch (e) {
        const status = (e && e.status) || 500;
        return res.status(status).json({ status: 'error', error: (e && e.message) || '生图失败' });
    }
});

// ---------- 非流式问答（降级路径） ----------
app.post('/api/query', async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ status: 'error', error: '服务端未配置 SILICONFLOW_API_KEY 环境变量' });
    const { question, history, clientVersion } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ status: 'error', error: 'question 不能为空' });
    try {
        const resp = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({ model: MODEL, ...MODEL_REQUEST_OPTIONS, messages: buildMessages(question, history), stream: false, max_tokens: MAX_TOKENS, temperature: TEMPERATURE })
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return res.status(502).json({ status: 'error', error: 'AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200) });
        }
        const data = await resp.json();
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        return res.json({ status: 'ok', text: content, html: renderClientAnswer(content, clientVersion) });
    } catch (e) {
        return res.status(500).json({ status: 'error', error: (e && e.message) || '内部错误' });
    }
});

// ---------- 流式问答（SSE，主路径） ----------
app.post('/api/query_stream', async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ status: 'error', error: '服务端未配置 SILICONFLOW_API_KEY 环境变量' });
    const { question, history, clientVersion } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ status: 'error', error: 'question 不能为空' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    const controller = new AbortController();
    let reader;
    let timedOut = false;
    const cancel = () => {
        if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', cancel);
    res.once('close', cancel);
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 180000);
    const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': heartbeat\n\n');
    }, 15000);
    const write = async (data) => {
        if (res.destroyed || res.writableEnded) throw new Error('客户端已断开连接');
        if (!res.write('data: ' + JSON.stringify(data) + '\n\n')) {
            await once(res, 'drain', { signal: controller.signal });
        }
    };

    try {
        await write({ type: 'start' });
        const resp = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Authorization': 'Bearer ' + apiKey },
            signal: controller.signal,
            body: JSON.stringify({ model: MODEL, ...MODEL_REQUEST_OPTIONS, messages: buildMessages(question, history), stream: true, max_tokens: MAX_TOKENS, temperature: TEMPERATURE })
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error('AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200));
        }
        if (!resp.body) throw new Error('AI服务未返回流式内容，请重试');
        reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '', full = '', eventData = [];
        let streamDone = false, finished = false, thinking = false;

        const dispatch = async () => {
            const payload = eventData.join('\n').trim();
            eventData = [];
            if (!payload) return;
            if (payload === '[DONE]') {
                streamDone = true;
                return;
            }
            let data;
            try { data = JSON.parse(payload); } catch {
                throw new Error('AI服务返回了无效的流式数据，请重试');
            }
            if (data.error || (data.code && !data.choices)) {
                throw new Error(String(data.error?.message || data.message || data.error || 'AI服务暂时不可用').slice(0, 200));
            }
            const choice = data.choices?.[0];
            const token = choice?.delta?.content;
            if (!thinking && !full && choice?.delta?.reasoning_content) {
                thinking = true;
                await write({ type: 'status', stage: 'thinking' });
            }
            if (typeof token === 'string' && token) {
                full += token;
                await write({ type: 'token', content: token });
            }
            if (choice?.finish_reason != null) finished = true;
        };
        const consumeLine = async (line) => {
            if (!line) return dispatch();
            const separator = line.indexOf(':');
            const field = separator < 0 ? line : line.slice(0, separator);
            if (field !== 'data') return;
            let value = separator < 0 ? '' : line.slice(separator + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            eventData.push(value);
        };
        const consume = async (chunk, final = false) => {
            buffer += chunk;
            while (!streamDone) {
                const newline = buffer.search(/[\r\n]/);
                if (newline < 0 || (!final && newline === buffer.length - 1 && buffer[newline] === '\r')) break;
                const line = buffer.slice(0, newline);
                const delimiterLength = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
                buffer = buffer.slice(newline + delimiterLength);
                await consumeLine(line);
            }
            if (final && !streamDone) {
                if (buffer) await consumeLine(buffer);
                buffer = '';
                await dispatch();
            }
        };

        while (!streamDone) {
            const { value, done } = await reader.read();
            if (done) {
                await consume(decoder.decode(), true);
                break;
            }
            await consume(decoder.decode(value, { stream: true }));
        }
        if (!streamDone && !finished) throw new Error('AI连接提前结束，回答尚未完成，请重试');
        if (!full.trim()) throw new Error('AI服务未生成回答，请重试');
        await write({ type: 'done', text: full, html: renderClientAnswer(full, clientVersion) });
        return res.end();
    } catch (e) {
        if (!res.destroyed && !res.writableEnded) {
            res.write('data: ' + JSON.stringify({ type: 'error', error: timedOut ? 'AI服务响应超时，请稍后重试' : (e && e.message) || '内部错误' }) + '\n\n');
            res.end();
        }
    } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        req.removeListener('aborted', cancel);
        res.removeListener('close', cancel);
        controller.abort();
        if (reader) await reader.cancel().catch(() => {});
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI七嫂服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`模型: ${MODEL} | API_KEY: ${getApiKey() ? '已配置' : '未配置'}`);
});
