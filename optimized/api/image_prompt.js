import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getApiKey } from './_config.js';
import { DEFAULT_SIZE, MAX_REFERENCE_IMAGES, generateImage, resolveSize, validateImagePayload } from './image_gen.js';
import { createImagePolicy, imageOwnerId, imagePolicy } from './image_policy.js';
import { createOptimizerClient, OptimizerClientError } from './optimizer_client.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const GENERATION_TTL_MS = 30 * 60 * 1000;
const CACHE_CAPACITY = 256;
const GLOBAL_CONCURRENCY = 2;
const GLOBAL_HOURLY_CALLS = 120;
const MAX_TOKEN_LENGTH = 49152;
const SAFE_ERROR = Symbol('safeImageError');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

function requestError(status, code, message, allowOriginal = false) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error[SAFE_ERROR] = true;
    if (allowOriginal) error.allowOriginal = true;
    return error;
}

function unavailable(status = 503) {
    return requestError(status, 'OPTIMIZATION_UNAVAILABLE', status === 504
        ? '理解需求超时，未开始生成。可以选择使用原始描述。'
        : '需求优化暂时不可用，未开始生成。可以选择使用原始描述。', true);
}

function blocked() {
    return requestError(422, 'OPTIMIZATION_BLOCKED', '该创作请求未通过内容安全检查，请调整描述。');
}

function cancelled() {
    return requestError(499, 'REQUEST_CANCELLED', '请求已取消，未开始新的生成。');
}

function checkSignal(signal) {
    if (signal?.aborted) throw cancelled();
}

function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestId(value, required = true) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || !UUID.test(value)) {
        throw requestError(400, 'INVALID_REQUEST_ID', '请求标识无效，请重新发起。');
    }
    return value.toLowerCase();
}

function metadata(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['prompt', 'size', 'referenceHashes', 'requestId'].includes(key))) {
        throw requestError(400, 'INVALID_IMAGE_INPUT', '需求准备参数无效，请勿上传图片内容。');
    }
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.trim().length > 4000) {
        throw requestError(400, 'INVALID_IMAGE_INPUT', '请填写 4000 字以内的图片描述。');
    }
    if (payload.size !== undefined && typeof payload.size !== 'string') {
        throw requestError(400, 'INVALID_IMAGE_INPUT', '尺寸选项无效。');
    }
    const size = (payload.size || DEFAULT_SIZE).trim() || DEFAULT_SIZE;
    resolveSize(size);
    if (!Array.isArray(payload.referenceHashes) || payload.referenceHashes.length > MAX_REFERENCE_IMAGES
        || payload.referenceHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) {
        throw requestError(400, 'INVALID_IMAGE_INPUT', '参考图校验信息无效，最多支持 20 张参考图。');
    }
    return { prompt: payload.prompt.trim(), size, referenceHashes: [...payload.referenceHashes], requestId: requestId(payload.requestId) };
}

function fingerprint(value) {
    return sha256(JSON.stringify(value));
}

function pruneCache(cache, now) {
    for (const [key, entry] of cache) {
        if (!entry.pending && entry.expiresAt <= now) cache.delete(key);
    }
}

function safeFailure(error, fallback) {
    if (error?.[SAFE_ERROR] === true) return error;
    return fallback;
}

function cached(cache, key, digest, ttl, now, execute, capacityError) {
    pruneCache(cache, now());
    const existing = cache.get(key);
    if (existing) {
        if (existing.digest !== digest) throw requestError(409, 'REQUEST_ID_CONFLICT', '同一请求标识的内容已改变，请重新发起。');
        if (existing.pending) return existing.promise;
        if (existing.failure) return Promise.reject(requestError(...existing.failure));
        return Promise.resolve(existing.result);
    }
    if (cache.size >= CACHE_CAPACITY) throw capacityError;
    const entry = { digest, pending: true, retain: false, expiresAt: now() + ttl, promise: null, result: null, failure: null };
    cache.set(key, entry);
    entry.promise = Promise.resolve().then(() => execute(() => { entry.retain = true; })).then(result => {
        entry.retain = true;
        entry.result = result;
        return result;
    }, error => {
        entry.failure = [error.status || 500, error.code || 'IMAGE_SERVICE_UNAVAILABLE', error.message || '服务暂时不可用。', Boolean(error.allowOriginal)];
        throw error;
    }).finally(() => {
        entry.pending = false;
        entry.expiresAt = now() + ttl;
        entry.promise = null;
        if (!entry.retain && cache.get(key) === entry) cache.delete(key);
    });
    return entry.promise;
}

export function createImagePromptService({ env = process.env, fetchImpl = (...args) => fetch(...args), generate = generateImage,
    getChatApiKey = getApiKey, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    policy = createImagePolicy({ now }), optimizerClient = createOptimizerClient({ env, fetchImpl, getChatApiKey, setTimer, clearTimer }) } = {}) {
    const secret = env.PROMPT_OPTIMIZER_SIGNING_KEY || randomBytes(32);
    const epoch = randomBytes(16).toString('hex');
    const preparations = new Map();
    const generations = new Map();
    const optimizationCalls = [];
    const generationCalls = [];
    let activeOptimizations = 0;
    let activeGenerations = 0;

    function getPromptOptimizationHealth() {
        return { promptOptimizationReady: optimizerClient.health().ready, promptOptimizationMode: 'text' };
    }

    function consumeGlobal(calls, limitError) {
        while (calls.length && now() - calls[0] >= 3600000) calls.shift();
        if (calls.length >= GLOBAL_HOURLY_CALLS) throw limitError;
        calls.push(now());
    }

    function sign(claims) {
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
        return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
    }

    function verify(token, owner, input, id, allowExpired = false) {
        const invalid = () => requestError(400, 'OPTIMIZATION_TOKEN_INVALID', '优化凭据无效，请重新理解需求。');
        if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
        const [encoded, signature] = token.split('.');
        const actual = Buffer.from(signature, 'base64url');
        const expected = createHmac('sha256', secret).update(encoded).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
        let claims;
        try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw invalid(); }
        if (!claims || claims.version !== 1 || claims.epoch !== epoch || claims.owner !== owner || claims.requestId !== id
            || typeof claims.originalPrompt !== 'string' || typeof claims.optimizedPrompt !== 'string'
            || !claims.optimizedPrompt || claims.optimizedPrompt.length > 4000 || !Array.isArray(claims.referenceHashes)
            || !Number.isFinite(claims.expiresAt) || !Number.isFinite(claims.issuedAt)
            || claims.expiresAt - claims.issuedAt !== TOKEN_TTL_MS || claims.issuedAt > now()) throw invalid();
        if (claims.expiresAt <= now() && !allowExpired) throw requestError(410, 'OPTIMIZATION_TOKEN_EXPIRED', '优化凭据已过期，请重新理解需求。');
        if (claims.originalPrompt !== input.prompt || claims.size !== input.sizeKey
            || fingerprint(claims.referenceHashes) !== fingerprint(input.referenceHashes)) {
            throw requestError(409, 'OPTIMIZATION_INPUT_CHANGED', '描述、尺寸或参考图已改变，请重新理解需求。');
        }
        return claims;
    }

    async function optimize(input, signal, markAttempted) {
        checkSignal(signal);
        if (!optimizerClient.health().ready) throw unavailable();
        if (activeOptimizations >= GLOBAL_CONCURRENCY) throw unavailable();
        activeOptimizations++;
        try {
            return await optimizerClient.optimize({ prompt: input.prompt, size: input.size, referenceCount: input.referenceHashes.length }, {
                signal, beforeSubmit() {
                    checkSignal(signal);
                    consumeGlobal(optimizationCalls, unavailable());
                    markAttempted();
                },
            });
        } catch (error) {
            if (signal?.aborted) throw cancelled();
            if (error instanceof OptimizerClientError) {
                if (error.kind === 'blocked') throw blocked();
                if (error.kind === 'cancelled') throw cancelled();
                throw unavailable([502, 503, 504].includes(error.status) ? error.status : 502);
            }
            throw safeFailure(error, unavailable(502));
        } finally {
            activeOptimizations--;
        }
    }

    async function prepareImagePrompt(payload, owner, { signal } = {}) {
        const input = metadata(payload);
        const ownerHash = imageOwnerId(owner);
        const key = ownerHash + ':' + input.requestId;
        checkSignal(signal);
        return cached(preparations, key, fingerprint(input), TOKEN_TTL_MS, now, async markAttempted => {
            checkSignal(signal);
            if (!optimizerClient.health().ready) throw unavailable();
            policy.consumeOptimization(owner);
            const decision = await optimize(input, signal, markAttempted);
            checkSignal(signal);
            if (decision.status !== 'ready') return decision;
            const issuedAt = now();
            const expiresAt = issuedAt + TOKEN_TTL_MS;
            const optimizationToken = sign({ version: 1, epoch, owner: ownerHash, requestId: input.requestId,
                originalPrompt: input.prompt, optimizedPrompt: decision.optimizedPrompt, size: input.size,
                referenceHashes: input.referenceHashes, issuedAt, expiresAt });
            return { ...decision, optimizationToken, expiresAt };
        }, unavailable());
    }

    async function generateImageRequest(payload, owner, apiKey, { signal, allowGeneration = () => true, admitted = false } = {}) {
        if (!apiKey) throw requestError(500, 'IMAGE_NOT_CONFIGURED', '服务端未配置 HUNYUAN_API_KEY，生图不可用');
        const hasToken = payload?.optimizationToken !== undefined;
        const id = requestId(payload?.requestId, hasToken);
        const input = validateImagePayload(payload, { strict: Boolean(id || hasToken), dataUrlsOnly: hasToken });
        input.referenceHashes = input.referenceImages.map(sha256);
        const ownerHash = imageOwnerId(owner);
        const key = ownerHash + ':' + id;
        if (hasToken && (typeof payload.optimizationToken !== 'string' || payload.optimizationToken.length > MAX_TOKEN_LENGTH)) {
            throw requestError(400, 'OPTIMIZATION_TOKEN_INVALID', '优化凭据无效，请重新理解需求。');
        }
        const digest = fingerprint({ prompt: input.prompt, size: input.sizeKey, references: input.referenceHashes,
            session: input.session, token: hasToken ? sha256(payload.optimizationToken) : '' });
        pruneCache(generations, now());
        const existing = id && generations.get(key);
        const allowExpired = Boolean(existing && existing.digest === digest
            && (existing.pending || existing.result || existing.failure?.[1] === 'IMAGE_GENERATION_UNKNOWN'));
        const claims = hasToken ? verify(payload.optimizationToken, ownerHash, input, id, allowExpired) : null;
        const prepared = id && preparations.get(key);
        if (!hasToken && prepared?.expiresAt > now()) {
            if (prepared.failure?.[1] === 'OPTIMIZATION_BLOCKED') throw blocked();
            if (prepared.pending || prepared.result?.status === 'needs_clarification') {
                throw requestError(409, 'OPTIMIZATION_NOT_READY', '请先完成需求确认，再开始生成。');
            }
        }
        const execute = async (markAttempted = () => {}) => {
            checkSignal(signal);
            if (activeGenerations >= GLOBAL_CONCURRENCY) throw requestError(503, 'IMAGE_BUSY', '生成任务较多，请稍后再试。');
            if (!allowGeneration()) throw requestError(429, 'IMAGE_RATE_LIMITED', '生成太频繁了，歇一会儿再来（每分钟 5 张、每小时 30 张）');
            if (!admitted) policy.reserveImage(owner);
            activeGenerations++;
            let submitted = false;
            const originalPrompt = input.prompt;
            const submittedPrompt = claims ? claims.optimizedPrompt : originalPrompt;
            try {
                checkSignal(signal);
                const result = await generate({ prompt: submittedPrompt, size: input.sizeKey,
                    referenceImages: input.referenceImages, session: input.session }, apiKey, { beforeSubmit() {
                    checkSignal(signal);
                    consumeGlobal(generationCalls, requestError(503, 'IMAGE_BUDGET_LIMITED', '本小时生成任务已达服务上限，请稍后再试。'));
                    submitted = true;
                    markAttempted();
                } });
                return { url: result.url, revisedPrompt: result.revisedPrompt, tokens: result.tokens,
                    originalPrompt, optimizedPrompt: claims ? submittedPrompt : '', submittedPrompt,
                    optimization: { status: claims ? 'applied' : 'disabled' } };
            } catch (error) {
                if (!submitted) throw safeFailure(error, requestError(503, 'IMAGE_SERVICE_UNAVAILABLE', '生成服务暂时不可用，未开始生成。'));
                if (error?.status === 422) throw requestError(422, 'IMAGE_CONTENT_BLOCKED', '提示词或结果被内容安全拦截，请调整描述。');
                if ([401, 402, 429].includes(error?.status)) {
                    throw requestError(error.status, 'IMAGE_UPSTREAM_REJECTED', error.status === 429 ? '生图服务排队较多，请稍后再试。' : '生图服务暂时不可用，请联系管理员检查配置或额度。');
                }
                throw requestError(error?.status === 504 ? 504 : 502, 'IMAGE_GENERATION_UNKNOWN', '生成可能已提交，请勿盲目重试；如需重新生成可能再次计费。');
            } finally {
                activeGenerations--;
            }
        };
        checkSignal(signal);
        if (!id) return execute();
        return cached(generations, key, digest, GENERATION_TTL_MS, now, execute,
            requestError(503, 'IMAGE_CACHE_FULL', '生成任务较多，请稍后再试。'));
    }

    return { getPromptOptimizationHealth, prepareImagePrompt, generateImageRequest };
}

const service = createImagePromptService({ policy: imagePolicy });
export const getPromptOptimizationHealth = service.getPromptOptimizationHealth;
export const prepareImagePrompt = service.prepareImagePrompt;
export const generateImageRequest = service.generateImageRequest;
