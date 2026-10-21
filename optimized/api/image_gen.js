import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_API_URL, IMAGE_MODEL, IMAGE_TIMEOUT } from './image_config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEN_DIR = path.join(__dirname, '..', 'public', 'static', 'gen');
const URL_PREFIX = '/static/gen/';

// 尺寸档位由服务端收敛，前端只能选 key，避免非法尺寸透传到上游
// 按「比例 + 横竖」给出档位，全部锁在 2K 以内：4K 出图成本高、体积大，明确不开放
export const SIZE_PRESETS = {
    '1:1': '2048x2048',   // 默认 方图
    '3:4': '1536x2048',   // 竖版
    '4:3': '2048x1536',   // 横版
    '9:16': '1152x2048',  // 竖屏（手机）
    '16:9': '2048x1152',  // 横屏
};
export const DEFAULT_SIZE = '1:1';

// 面积极限 2048×2048，任何档位超过它都直接拒绝
const MAX_AREA = 2048 * 2048;

// 默认档位兜底：前端没传就按 2K
function resolveSize(sizeKey) {
    const key = String(sizeKey || '').trim() || DEFAULT_SIZE;
    if (!Object.prototype.hasOwnProperty.call(SIZE_PRESETS, key)) {
        throw httpError(400, '不支持的尺寸选项');
    }
    const size = SIZE_PRESETS[key];
    const matched = /^(\d+)x(\d+)$/.exec(size);
    if (!matched) throw httpError(500, '尺寸配置有误');
    const area = Number(matched[1]) * Number(matched[2]);
    if (area > MAX_AREA) throw httpError(400, '当前仅支持最高 2K 出图（2048×2048 以内）');
    return size;
}

// 落盘保留策略：最多 160 张 / 24 小时
const MAX_FILES = 160;
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_REF_CHARS = 14_000_000; // 约 10MB 图片的 base64
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function sanitizeReference(value) {
    if (!value) return '';
    const str = String(value).trim();
    if (!str) return '';
    if (str.length > MAX_REF_CHARS) throw httpError(413, '参考图太大了，请换一张（建议 5MB 以内）');
    if (/^https?:\/\/\S+$/i.test(str)) return str;
    const dataUrl = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(str);
    if (dataUrl) {
        const buffer = decodeImageBase64(dataUrl[2], 400);
        const extension = sniffExt(buffer);
        const mimeExtension = /^jpe?g$/i.test(dataUrl[1]) ? 'jpg' : dataUrl[1].toLowerCase();
        if (extension !== mimeExtension) throw httpError(400, '参考图内容与格式不符');
        return str;
    }
    throw httpError(400, '参考图格式不支持，请上传 PNG / JPG / WebP 图片');
}

function sniffExt(buf) {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && buf.toString('ascii', 12, 16) === 'IHDR') return 'png';
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF'
        && buf.toString('ascii', 8, 12) === 'WEBP'
        && /^(VP8 |VP8L|VP8X)$/.test(buf.toString('ascii', 12, 16))) return 'webp';
    return '';
}

function decodeImageBase64(value, status = 502) {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024) {
        throw httpError(status, '图片内容无效或超过 20MB');
    }
    const encoded = value.replace(/\s/g, '');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
        throw httpError(status, '图片 Base64 内容无效');
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
        || buffer.length > MAX_IMAGE_BYTES || !sniffExt(buffer)) {
        throw httpError(status, '仅支持有效的 PNG / JPG / WebP 图片（20MB 以内）');
    }
    return buffer;
}

async function saveBuffer(buf) {
    const extension = sniffExt(buf);
    if (!extension || buf.length > MAX_IMAGE_BYTES) throw httpError(502, '上游返回的图片格式无效或超过 20MB');
    await mkdir(GEN_DIR, { recursive: true });
    const name = Date.now().toString(36) + randomBytes(4).toString('hex') + '.' + extension;
    await writeFile(path.join(GEN_DIR, name), buf);
    return URL_PREFIX + name;
}

async function readLimitedBody(response, signal, maxBytes) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
        response.body?.cancel().catch(() => {});
        throw httpError(502, '上游响应超过大小限制');
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    let abort;
    const aborted = new Promise((resolve, reject) => {
        abort = () => {
            reader.cancel().catch(() => {});
            reject(signal.reason || new DOMException('请求超时', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
    });
    const chunks = [];
    let size = 0;
    try {
        signal.throwIfAborted();
        while (true) {
            const result = await Promise.race([reader.read(), aborted]);
            signal.throwIfAborted();
            if (result.done) return Buffer.concat(chunks, size);
            size += result.value.byteLength;
            if (size > maxBytes) throw httpError(502, '上游响应超过大小限制');
            chunks.push(Buffer.from(result.value));
        }
    } finally {
        signal.removeEventListener('abort', abort);
        reader.cancel().catch(() => {});
    }
}

function imageDownloadUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw httpError(502, '上游图片地址无效'); }
    const knownHost = /^(?:aigc-output-image-file|hunyuan-image-result-tob)-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(url.hostname)
        || url.hostname === 'aigc-image.cos.myqcloud.com';
    if (url.protocol !== 'https:' || !knownHost || url.username || url.password || url.port
        || /[\u0000-\u0020\u007f]/.test(String(value))) {
        throw httpError(502, '上游图片地址不在允许的腾讯 COS HTTPS 域名中');
    }
    return url;
}

async function fetchWithTimeout(url, options, timeoutMs, maxBytes, allowImageRedirect = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let current = allowImageRedirect ? imageDownloadUrl(url) : new URL(url);
        for (let redirect = 0; redirect <= 3; redirect++) {
            const response = await fetch(current, { ...options, signal: controller.signal, redirect: 'manual' });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                response.body?.cancel().catch(() => {});
                const location = response.headers.get('location');
                if (!allowImageRedirect || !location || redirect === 3) throw httpError(502, '上游返回了不允许的重定向');
                current = imageDownloadUrl(new URL(location, current).href);
                continue;
            }
            const buffer = await readLimitedBody(response, controller.signal, maxBytes);
            return { ok: response.ok, status: response.status, buffer };
        }
    } finally {
        clearTimeout(timer);
    }
}

async function downloadImage(remoteUrl) {
    try {
        const resp = await fetchWithTimeout(remoteUrl, {}, 60000, MAX_IMAGE_BYTES, true);
        if (!resp.ok) throw httpError(502, '图片已生成但下载失败（HTTP ' + resp.status + '），请重试');
        return await saveBuffer(resp.buffer);
    } catch (error) {
        if (error?.name === 'AbortError') throw httpError(504, '图片下载超时，请稍后重试');
        throw error;
    }
}

// 清理过期与超出数量的历史图，失败静默（不影响出图）
async function collectGarbage() {
    try {
        const files = await readdir(GEN_DIR);
        const now = Date.now();
        const entries = [];
        for (const file of files) {
            if (!/\.(png|jpg|webp)$/i.test(file)) continue;
            try {
                const info = await stat(path.join(GEN_DIR, file));
                if (!info.isFile()) continue;
                if (now - info.mtimeMs > MAX_AGE_MS) {
                    await unlink(path.join(GEN_DIR, file)).catch(() => {});
                } else {
                    entries.push({ file, mtime: info.mtimeMs });
                }
            } catch { /* 单个文件异常跳过 */ }
        }
        if (entries.length > MAX_FILES) {
            entries.sort((a, b) => a.mtime - b.mtime);
            for (const item of entries.slice(0, entries.length - MAX_FILES)) {
                await unlink(path.join(GEN_DIR, item.file)).catch(() => {});
            }
        }
    } catch { /* 目录不存在等情况忽略 */ }
}

function upstreamFailure(status, body) {
    const err = (body && body.error) || {};
    const code = err.code || '';
    const raw = err.message_zh || err.message || '';
    if (code === '401007' || /postpaid|后付费|free trial quota/i.test(raw)) {
        return httpError(402, '生图服务额度未开通：请到腾讯云控制台 › 在线推理服务 开启后付费后重试');
    }
    if (status === 401) return httpError(401, '生图服务鉴权失败，请检查服务端的 HUNYUAN_API_KEY');
    if (status === 422 || code === 'content_filter') return httpError(422, '提示词或结果被内容安全拦截，换个说法再试');
    if (status === 429) return httpError(429, '当前排队较多（并发超限），等几秒再试');
    if (status >= 500) return httpError(502, '生图服务暂时异常，请稍后重试');
    return httpError(502, '生图失败：' + (raw || ('HTTP ' + status)).slice(0, 160));
}

/**
 * @param {{ prompt: string, size?: string, referenceImage?: string, session?: string }} payload
 * @returns {Promise<{ url: string, revisedPrompt: string, tokens: number }>}
 */
export async function generateImage(payload, apiKey) {
    if (!apiKey) throw httpError(500, '服务端未配置 HUNYUAN_API_KEY，生图不可用');

    const prompt = String((payload && payload.prompt) || '').trim();
    if (!prompt) throw httpError(400, '请先写清楚想生成什么');
    if (prompt.length > 4000) throw httpError(400, '提示词太长了，控制在 4000 字以内');

    const sizeKey = String((payload && payload.size) || DEFAULT_SIZE);
    const size = resolveSize(sizeKey);

    const referenceImage = sanitizeReference(payload && payload.referenceImage);
    const session = String((payload && payload.session) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

    const content = [{ type: 'text', text: prompt }];
    if (referenceImage) content.push({ type: 'image_url', image_url: { url: referenceImage } });

    const body = { model: IMAGE_MODEL, messages: [{ role: 'user', content }], size };
    if (session) body.session = session;

    let resp;
    try {
        resp = await fetchWithTimeout(IMAGE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
            body: JSON.stringify(body),
        }, IMAGE_TIMEOUT, MAX_JSON_BYTES);
    } catch (e) {
        if (e && e.name === 'AbortError') throw httpError(504, '生成超时（150 秒），稍后重试或换个更简单的描述');
        throw httpError(502, '连接生图服务失败：' + ((e && e.message) || '网络错误'));
    }

    const text = resp.buffer.toString('utf8');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 走错误映射 */ }

    if (!resp.ok || data?.error) throw upstreamFailure(resp.status, data);

    const item = data?.choices?.[0]?.delta?.image || (Array.isArray(data?.data) && data.data[0]) || {};
    const revoked = item.revised_prompt || '';

    let url;
    if (item.b64_json || item.b64) {
        url = await saveBuffer(decodeImageBase64(item.b64_json || item.b64));
    } else if (item.url) {
        url = await downloadImage(item.url);
    } else {
        throw httpError(502, '生图服务没有返回图片，请重试');
    }

    collectGarbage();

    return {
        url,
        revisedPrompt: revoked,
        tokens: (data && data.tokenhub_usage && data.tokenhub_usage.total_tokens) || 0,
    };
}
