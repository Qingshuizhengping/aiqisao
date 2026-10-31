/**
 * @file Upstream client for the Hunyuan image model (requirement R2-05/06/07).
 *
 * The contract was verified against the running reference implementation:
 *   POST https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation
 *   Authorization: Bearer <KEY>          (plain bearer token, NOT a Tencent Cloud TC3 signature)
 *   body: { model, messages:[{role:'user',content:[{type:'text',text:prompt}]}], size? }
 *
 * There is no `negative_prompt` / `style` / `num` field, so the UI offers none.
 *
 * Failure handling is the important part: every failure becomes one of six *distinct* user
 * facing codes, and "we submitted but do not know the result" is its own code that is never
 * retried automatically (the request may already have been billed).
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveSize } from './image-sizes.js';

/**
 * A classified image failure. `message` is the *user facing* text and never contains the
 * upstream body (which can include prompt fragments or internal diagnostics).
 */
export class ImageFailure extends Error {
    /**
     * @param {string} code Machine readable `IMAGE_*` code.
     * @param {string} message User facing Chinese message.
     * @param {{status?: number, cause?: unknown}} [details] Internal details (not serialized).
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ImageFailure';
        this.code = code;
        this.status = details.status || 502;
        this.cause = details.cause;
    }
}

/** User facing texts, one per code. They must stay mutually distinct (asserted by tests). */
export const IMAGE_MESSAGES = Object.freeze({
    IMAGE_UPSTREAM_QUOTA: '生图服务额度未开通，请联系管理员',
    IMAGE_UPSTREAM_AUTH: '生图服务鉴权失败，请联系管理员',
    IMAGE_CONTENT_BLOCKED: '这段描述未通过内容安全检查，换个说法再试',
    IMAGE_UPSTREAM_BUSY: '现在排队的人多，等一会儿再点',
    IMAGE_UPSTREAM_ERROR: '生图服务暂时不可用，稍后重试',
    IMAGE_RESULT_UNKNOWN: '这张可能已经生成并计费了，别急着重试——先刷新历史看一眼',
    IMAGE_JOB_INTERRUPTED: '服务重启中断了任务，未自动重新提交；请先看历史确认是否已生成',
    IMAGE_JOB_CANCELLED: '任务排队时服务重启，未提交，可安全重试',
    IMAGE_NOT_CONFIGURED: '生图服务未配置，请联系管理员',
});

const COS_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-\d+\.cos\.[a-z]{2}-[a-z0-9-]+\.myqcloud\.com$/i;
const COS_EXTRA_HOST = 'aigc-image.cos.myqcloud.com';
const MAX_REDIRECTS = 3;
const JSON_BYTES = 32 * 1024 * 1024;

/**
 * Detects the image type from its magic bytes. Upstream names are never trusted.
 *
 * @param {Buffer} buffer Image bytes.
 * @returns {{extension: 'png'|'jpg'|'webp', mime: string}|null} Detection result.
 */
export function sniffImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && buffer.toString('ascii', 12, 16) === 'IHDR') return { extension: 'png', mime: 'image/png' };
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return { extension: 'webp', mime: 'image/webp' };
    }
    return null;
}

/**
 * Reads width/height out of the image header (best effort; `null` when unknown).
 *
 * @param {Buffer} buffer Image bytes.
 * @param {'png'|'jpg'|'webp'} extension Detected extension.
 * @returns {{width: number|null, height: number|null}} Pixel dimensions.
 */
export function imageDimensions(buffer, extension) {
    try {
        if (extension === 'png' && buffer.length >= 24) {
            return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
        }
        if (extension === 'jpg') {
            let offset = 2;
            while (offset + 9 < buffer.length) {
                if (buffer[offset] !== 0xff) { offset += 1; continue; }
                const marker = buffer[offset + 1];
                const length = buffer.readUInt16BE(offset + 2);
                // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the dimensions.
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                    return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
                }
                offset += 2 + Math.max(length, 2);
            }
            return { width: null, height: null };
        }
        if (extension === 'webp' && buffer.length >= 30) {
            const kind = buffer.toString('ascii', 12, 16);
            if (kind === 'VP8X') {
                const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
                const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
                return { width, height };
            }
            if (kind === 'VP8 ') {
                return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
            }
            if (kind === 'VP8L') {
                const bits = buffer.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
            }
        }
    } catch { /* fall through: dimensions are cosmetic */ }
    return { width: null, height: null };
}

/** @param {string} value Candidate remote url. @returns {URL|null} Allowed url or null. */
function allowedDownloadUrl(value) {
    let url;
    try { url = new URL(String(value)); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (/[\u0000-\u0020\u007f]/.test(String(value))) return null;
    if (url.hostname === COS_EXTRA_HOST || COS_HOST.test(url.hostname)) return url;
    return null;
}

/**
 * Maps an upstream HTTP status/body to a classified failure.
 *
 * @param {number} status HTTP status.
 * @param {Object|null} body Parsed body, when available.
 * @returns {ImageFailure} Classified failure.
 */
export function classifyUpstream(status, body) {
    const detail = (body && body.error) || {};
    const code = String(detail.code || '');
    const raw = String(detail.message_zh || detail.message || '');
    if (code === '401007' || /postpaid|后付费|free trial quota/i.test(raw)) {
        return new ImageFailure('IMAGE_UPSTREAM_QUOTA', IMAGE_MESSAGES.IMAGE_UPSTREAM_QUOTA, { status: 402 });
    }
    // Never 401: `src/api.js` logs out on any 401 and this has nothing to do with the
    // member's session.
    if (status === 401 || status === 403) {
        return new ImageFailure('IMAGE_UPSTREAM_AUTH', IMAGE_MESSAGES.IMAGE_UPSTREAM_AUTH, { status: 502 });
    }
    if (status === 422 || code === 'content_filter' || /content_?filter|安全|审核/i.test(raw)) {
        return new ImageFailure('IMAGE_CONTENT_BLOCKED', IMAGE_MESSAGES.IMAGE_CONTENT_BLOCKED, { status: 422 });
    }
    if (status === 429) {
        return new ImageFailure('IMAGE_UPSTREAM_BUSY', IMAGE_MESSAGES.IMAGE_UPSTREAM_BUSY, { status: 429 });
    }
    return new ImageFailure('IMAGE_UPSTREAM_ERROR', IMAGE_MESSAGES.IMAGE_UPSTREAM_ERROR, { status: 502 });
}

/** @param {Object} data Parsed upstream payload. @returns {{b64: string, url: string}} Image reference. */
function imageReference(data) {
    const delta = data?.choices?.[0]?.delta?.image;
    const candidate = delta && typeof delta === 'object' ? delta : (Array.isArray(data?.data) ? data.data[0] : null);
    if (!candidate || typeof candidate !== 'object') return { b64: '', url: '' };
    return { b64: String(candidate.b64_json || candidate.b64 || ''), url: String(candidate.url || '') };
}

/** @param {string} value Base64 image payload. @returns {Buffer} Decoded bytes. */
function decodeBase64Image(value) {
    const encoded = value.replace(/\s/g, '');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
        throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
    }
    return buffer;
}

/** @param {string} value User prompt; kept only for the input hash. @returns {string} Hash. */
export function promptHash(prompt, sizeKey) {
    return createHash('sha256').update(JSON.stringify([prompt, sizeKey || ''])).digest('hex');
}

/**
 * Creates the upstream client.
 *
 * @param {{config: Object, fetchImpl?: typeof fetch}} options Options. `fetchImpl` is always
 *     injected in tests so no test can ever reach the real endpoint.
 * @returns {{generate: (input: {id: string, prompt: string, sizeKey: string, signal?: AbortSignal}) => Promise<{fileName: string, mimeType: string, byteSize: number, width: number|null, height: number|null, upstreamMs: number}>}}
 */
export function createImageUpstream({ config = {}, fetchImpl } = {}) {
    const transport = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    const timeoutMs = Number(config.imageTimeoutMs) || 150000;
    const maxBytes = Number(config.imageMaxBytes) || 20971520;
    const directory = path.resolve(config.imageDirectory || 'var/images');

    /**
     * Writes the image to `<imageDirectory>/<yyyyMM>/<jobId>.<ext>` with private permissions.
     *
     * @param {{id: string}} job Job identity.
     * @param {Buffer} buffer Image bytes.
     * @returns {Promise<{fileName: string, mimeType: string, byteSize: number, width: number|null, height: number|null}>} Stored file metadata.
     */
    async function store(job, buffer) {
        if (!buffer.length || buffer.length > maxBytes) {
            throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
        }
        const sniffed = sniffImage(buffer);
        if (!sniffed) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
        const folder = new Date().toISOString().slice(0, 7).replace('-', '');
        const fileName = path.join(folder, job.id + '.' + sniffed.extension);
        const target = path.resolve(directory, fileName);
        if (!target.startsWith(directory + path.sep)) throw new Error('Image path escaped the image directory');
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, buffer, { mode: 0o600 });
        const { width, height } = imageDimensions(buffer, sniffed.extension);
        return { fileName, mimeType: sniffed.mime, byteSize: buffer.length, width, height };
    }

    /**
     * Fetches an upstream hosted image, following at most three same-allowlist redirects.
     *
     * @param {string} remote Remote url from the upstream payload.
     * @param {AbortSignal} signal Abort signal.
     * @returns {Promise<Buffer>} Image bytes.
     */
    async function download(remote, signal) {
        let current = allowedDownloadUrl(remote);
        if (!current) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            let response;
            try {
                response = await transport(current.href, { method: 'GET', signal, redirect: 'manual' });
            } catch (error) {
                // The image may already exist upstream: do not pretend it failed cleanly.
                throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN, { cause: error });
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers?.get?.('location');
                if (!location || hop === MAX_REDIRECTS) {
                    throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
                }
                current = allowedDownloadUrl(new URL(location, current).href);
                if (!current) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
                continue;
            }
            if (!response.ok) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > maxBytes) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
            return buffer;
        }
        throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
    }

    return {
        /**
         * Generates one image and stores it on disk.
         *
         * @param {{id: string, prompt: string, sizeKey: string, signal?: AbortSignal}} input Job input.
         * @returns {Promise<Object>} Stored file metadata plus `upstreamMs`.
         */
        async generate({ id, prompt, sizeKey, signal }) {
            if (!config.imageApiKey) throw new ImageFailure('IMAGE_NOT_CONFIGURED', IMAGE_MESSAGES.IMAGE_NOT_CONFIGURED, { status: 503 });
            const size = resolveSize(sizeKey);
            const body = { model: config.imageModel || 'hy-image-v3.5-preview',
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
            if (size) body.size = size;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('image upstream timeout')), timeoutMs);
            timer.unref?.();
            const forward = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', forward, { once: true });
            const startedAt = Date.now();
            try {
                let response;
                try {
                    response = await transport(config.imageApiBase, { method: 'POST', signal: controller.signal,
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.imageApiKey },
                        body: JSON.stringify(body) });
                } catch (error) {
                    // Timeout / connection reset / DNS: the request may have been accepted and
                    // billed, so this is "unknown", never a clean retryable failure.
                    throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN, { cause: error });
                }
                if (response.status === undefined) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
                let payload = null;
                const text = await response.text?.().catch(() => '');
                if (typeof text === 'string' && text) {
                    try { payload = JSON.parse(text); } catch { payload = null; }
                }
                if (!response.ok || (payload && payload.error)) throw classifyUpstream(response.status, payload);
                if (text && text.length > JSON_BYTES) throw new ImageFailure('IMAGE_UPSTREAM_ERROR', IMAGE_MESSAGES.IMAGE_UPSTREAM_ERROR);

                const reference = imageReference(payload);
                let buffer;
                if (reference.b64) buffer = decodeBase64Image(reference.b64);
                else if (reference.url) buffer = await download(reference.url, controller.signal);
                else throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);

                if (buffer.length > maxBytes) throw new ImageFailure('IMAGE_RESULT_UNKNOWN', IMAGE_MESSAGES.IMAGE_RESULT_UNKNOWN);
                const stored = await store({ id }, buffer);
                return { ...stored, upstreamMs: Date.now() - startedAt };
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', forward);
            }
        },
        /** @returns {{configured: boolean, model: string}} Non-secret health summary. */
        health: () => ({ configured: Boolean(config.imageApiKey), model: config.imageModel || 'hy-image-v3.5-preview' }),
    };
}
