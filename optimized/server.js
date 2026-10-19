// AI 七嫂 · 阿里云部署版服务端
// 相比原 server.js 的三处改动：
//   1. 预压缩资源直出（public 下的 .br/.gz 由 build.py 生成），不再每次现压
//   2. 按文件类型下发缓存策略，静态资源可被浏览器/CDN 复用
//   3. 静态文件关闭 etag 二次读盘，改用 mtime + 长的 stalez 窗口
import express from 'express';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, MODEL, MAX_TOKENS, TEMPERATURE, buildMessages, textToHtml, getApiKey } from './api/_config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------- 静态资源：预压缩 + 分类缓存 ----------
// 顺序即优先级：sw.js / manifest 必须排在 .js 之前，否则会被当成普通脚本缓存一天，
// 导致发版后老用户迟迟拿不到新版本。
const CACHE_RULES = [
    { test: /manifest\.json$/i, value: 'public, max-age=0, must-revalidate' },
    { test: /[/\\]sw\.js$/i, value: 'public, max-age=0, must-revalidate' },
    { test: /\.(?:png|webp|jpg|jpeg|svg|ico)$/i, value: 'public, max-age=2592000' },
    { test: /\.(?:css|js|mjs)$/i, value: 'public, max-age=86400, stale-while-revalidate=604800' },
];

function cacheFor(filePath) {
    for (const rule of CACHE_RULES) if (rule.test.test(filePath)) return rule.value;
    return 'public, max-age=0, must-revalidate';
}

app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let rel = decodeURIComponent(req.path);
    if (rel === '/' || rel === '') rel = '/index.html';

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
app.get('/api/health', (req, res) => res.json({ status: 'ok', model: MODEL }));

// ---------- 非流式问答（降级路径） ----------
app.post('/api/query', async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ status: 'error', error: '服务端未配置 SILICONFLOW_API_KEY 环境变量' });
    const { question, history } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ status: 'error', error: 'question 不能为空' });
    try {
        const resp = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({ model: MODEL, messages: buildMessages(question, history), stream: false, max_tokens: MAX_TOKENS, temperature: TEMPERATURE })
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return res.status(502).json({ status: 'error', error: 'AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200) });
        }
        const data = await resp.json();
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        return res.json({ status: 'ok', html: textToHtml(content) });
    } catch (e) {
        return res.status(500).json({ status: 'error', error: (e && e.message) || '内部错误' });
    }
});

// ---------- 流式问答（SSE，主路径） ----------
app.post('/api/query_stream', async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ status: 'error', error: '服务端未配置 SILICONFLOW_API_KEY 环境变量' });
    const { question, history } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ status: 'error', error: 'question 不能为空' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

    try {
        const resp = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({ model: MODEL, messages: buildMessages(question, history), stream: true, max_tokens: MAX_TOKENS, temperature: TEMPERATURE })
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            write({ type: 'error', error: 'AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200) });
            return res.end();
        }
        write({ type: 'start' });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '', full = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let data;
                try { data = JSON.parse(payload); } catch (e) { continue; }
                const token = data && data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
                if (token) { full += token; write({ type: 'token', content: token }); }
            }
        }
        write({ type: 'done', html: textToHtml(full) });
        return res.end();
    } catch (e) {
        write({ type: 'error', error: (e && e.message) || '内部错误' });
        return res.end();
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI七嫂服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`模型: ${MODEL} | API_KEY: ${getApiKey() ? '已配置' : '未配置'}`);
});
