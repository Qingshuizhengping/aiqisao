import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getImageApiKey } from './image_config.js';
import { validateImagePayload } from './image_gen.js';
import { generateImageRequest, prepareImagePrompt } from './image_prompt.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const TERMINAL = new Set(['succeeded', 'needs_clarification', 'failed', 'interrupted']);
const STATES = new Set(['queued', 'optimizing', 'generating', ...TERMINAL]);
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../var/image-jobs/', import.meta.url));
const RETENTION_MS = 24 * 3600000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const RUNNING_DIRECTORIES = new Map();

function failure(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

function identifier(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw failure(400, 'INVALID_REQUEST_ID', '请求标识无效，请重新发起。');
    return value.toLowerCase();
}

function tokenDigest(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw failure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
    return digest(token.toLowerCase());
}

function authorized(record, tokenHash) {
    const stored = Buffer.from(record.tokenHash, 'hex');
    const received = Buffer.from(tokenHash, 'hex');
    return stored.length === received.length && timingSafeEqual(stored, received);
}

function normalize(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['requestId', 'prompt', 'size', 'referenceImages', 'optimize'].includes(key))
        || (payload.optimize !== undefined && typeof payload.optimize !== 'boolean')) {
        throw failure(400, 'INVALID_IMAGE_INPUT', '后台生成参数无效。');
    }
    const input = validateImagePayload(payload, { strict: true, dataUrlsOnly: true });
    const id = identifier(payload.requestId);
    const data = { prompt: input.prompt, size: input.sizeKey, referenceImages: input.referenceImages, optimize: payload.optimize !== false };
    const inputHash = digest(JSON.stringify({ ...data, referenceImages: data.referenceImages.map(digest) }));
    return { id, data, inputHash };
}

function snapshot(record) {
    const job = { id: record.id, state: record.state, createdAt: record.createdAt, updatedAt: record.updatedAt,
        originalPrompt: record.originalPrompt, size: record.size, referenceCount: record.referenceCount };
    for (const name of ['optimization', 'result', 'question', 'error', 'code', 'allowOriginal']) {
        if (record[name] !== undefined) job[name] = record[name];
    }
    return { status: 'ok', job: JSON.parse(JSON.stringify(job)) };
}

function completedResult(result, record) {
    if (!result || typeof result.url !== 'string' || !/^\/static\/gen\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/.test(result.url)) {
        throw failure(502, 'IMAGE_GENERATION_UNKNOWN', '生成结果未能保存，请勿盲目重试；重新生成可能再次计费。');
    }
    const optimizedPrompt = record.optimization?.optimizedPrompt || '';
    return { url: result.url, revisedPrompt: typeof result.revisedPrompt === 'string' ? result.revisedPrompt.slice(0, 4000) : '',
        tokens: typeof result.tokens === 'number' && Number.isFinite(result.tokens) && result.tokens >= 0 ? result.tokens : 0,
        originalPrompt: record.originalPrompt, optimizedPrompt, submittedPrompt: optimizedPrompt || record.originalPrompt,
        optimization: { status: optimizedPrompt ? 'applied' : 'disabled' } };
}

export function createImageJobService({ storeDirectory = DEFAULT_DIRECTORY, prepare = prepareImagePrompt,
    generate = generateImageRequest, getApiKey = getImageApiKey, now = () => Date.now(), concurrency = 2,
    capacity = 64, queueCapacity = 8, retentionMs = RETENTION_MS } = {}) {
    const directory = path.resolve(storeDirectory);
    const records = new Map();
    const workers = new Map();
    const admissions = new Map();
    const runner = {};
    const maximumWorkers = Math.min(2, Math.max(1, Math.floor(concurrency) || 1));
    let initialization;
    let closing = false;
    let scheduled = false;
    let cleanupTimer;
    let mutation = Promise.resolve();

    function locked(operation) {
        const pending = mutation.then(operation, operation);
        mutation = pending.catch(() => {});
        return pending;
    }

    function filename(id) {
        return path.join(directory, id + '.json');
    }

    async function persist(record) {
        const temporary = filename(record.id) + '.' + randomBytes(8).toString('hex') + '.tmp';
        let handle;
        try {
            handle = await open(temporary, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(record));
            await handle.sync();
            await handle.close();
            handle = null;
            await rename(temporary, filename(record.id));
            if (process.platform !== 'win32') {
                const parent = await open(directory, 'r');
                try { await parent.sync(); } finally { await parent.close(); }
            }
        } finally {
            await handle?.close().catch(() => {});
            await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    async function clean() {
        for (const [id, record] of records) {
            if (TERMINAL.has(record.state) && record.updatedAt + retentionMs <= now()) {
                await unlink(filename(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
                records.delete(id);
            }
        }
        for (const [owner, record] of admissions) {
            if (!record.hour.some(time => now() - time < 3600000)) admissions.delete(owner);
        }
    }

    function admit(owner) {
        if (!admissions.has(owner) && admissions.size >= 2048) throw failure(503, 'IMAGE_JOB_BUSY', '后台任务较多，请稍后再试。');
        const record = admissions.get(owner) || { minute: [], hour: [] };
        record.minute = record.minute.filter(time => now() - time < 60000);
        record.hour = record.hour.filter(time => now() - time < 3600000);
        if (record.minute.length >= 5 || record.hour.length >= 30) {
            throw failure(429, 'IMAGE_RATE_LIMITED', '生成太频繁了，请稍后再试（每分钟 5 次、每小时 30 次）。');
        }
        return () => {
            record.minute.push(now());
            record.hour.push(now());
            admissions.set(owner, record);
        };
    }

    async function transition(record, state, fields = {}) {
        const updated = { ...record, ...fields, state, updatedAt: now() };
        if (TERMINAL.has(state)) delete updated.payload;
        await persist(updated);
        Object.assign(record, updated);
        if (TERMINAL.has(state)) delete record.payload;
    }

    async function execute(record) {
        let imageAttempted = false;
        try {
            const input = record.payload;
            const apiKey = getApiKey();
            if (!apiKey) throw failure(503, 'IMAGE_NOT_CONFIGURED', '生图服务暂时不可用，请联系管理员。');
            let prepared;
            if (input.optimize) {
                await transition(record, 'optimizing');
                prepared = await prepare({ prompt: input.prompt, size: input.size,
                    referenceHashes: input.referenceImages.map(digest), requestId: record.id }, record.owner);
                if (prepared.status === 'needs_clarification') {
                    await transition(record, 'needs_clarification', { question: prepared.question });
                    return;
                }
                if (prepared.status !== 'ready' || !prepared.optimizationToken || prepared.originalPrompt !== input.prompt) {
                    throw failure(502, 'OPTIMIZATION_UNAVAILABLE', '需求优化暂时不可用，未开始生成。');
                }
                record.optimization = { originalPrompt: prepared.originalPrompt,
                    optimizedPrompt: prepared.optimizedPrompt, intent: prepared.intent };
            }
            await transition(record, 'generating');
            imageAttempted = true;
            const result = await generate({ prompt: input.prompt, size: input.size, referenceImages: input.referenceImages,
                requestId: record.id, ...(prepared ? { optimizationToken: prepared.optimizationToken } : {}) }, record.owner, apiKey);
            await transition(record, 'succeeded', { result: completedResult(result, record) });
        } catch (error) {
            const optimizing = record.state === 'optimizing';
            const known = typeof error?.code === 'string' && /^(?:OPTIMIZATION_|IMAGE_|REQUEST_)[A-Z_]+$/.test(error.code);
            const code = known ? error.code : imageAttempted ? 'IMAGE_GENERATION_UNKNOWN' : 'IMAGE_JOB_FAILED';
            const message = known && typeof error.message === 'string' ? error.message : imageAttempted
                ? '生成可能已提交，请勿盲目重试；如需重新生成可能再次计费。' : '生成服务暂时不可用，请稍后再试。';
            await transition(record, 'failed', { error: message.slice(0, 500), code,
                allowOriginal: Boolean(optimizing && code === 'OPTIMIZATION_UNAVAILABLE' && error.allowOriginal === true) });
        }
    }

    function schedule() {
        if (scheduled || closing) return;
        scheduled = true;
        setImmediate(() => {
            scheduled = false;
            if (closing) return;
            for (const record of records.values()) {
                if (workers.size >= maximumWorkers) break;
                if (record.state !== 'queued' || workers.has(record.id)) continue;
                const worker = execute(record).catch(() => {}).finally(() => {
                    workers.delete(record.id);
                    schedule();
                });
                workers.set(record.id, worker);
            }
        });
    }

    async function initialize() {
        let ancestor = directory;
        while (true) {
            const info = await lstat(ancestor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
            if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Invalid private image job directory ancestor');
            if (path.basename(ancestor).toLowerCase() === 'public') throw new Error('Image job storage must not be publicly served');
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid private image job directory');
        const resolved = await realpath(directory);
        if (path.resolve(resolved).toLowerCase() !== directory.toLowerCase()) throw new Error('Private image job directory must resolve without aliases');
        await chmod(directory, 0o700);
        const contents = await readdir(directory, { withFileTypes: true });
        for (const entry of contents) {
            if (!/^[0-9a-f-]{36}\.json\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue;
            if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid temporary private image job entry');
            await unlink(path.join(directory, entry.name));
        }
        const entries = contents.filter(entry => entry.name.endsWith('.json'));
        if (entries.length > capacity) throw new Error('Private image job capacity exceeded');
        let outstandingCount = 0;
        for (const entry of entries) {
            const id = entry.name.slice(0, -5);
            if (!UUID.test(id) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid private image job entry');
            const info = await lstat(filename(id));
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) throw new Error('Invalid private image job entry');
            await chmod(filename(id), 0o600);
            const record = JSON.parse(await readFile(filename(id), 'utf8'));
            if (record.version !== 1 || record.id !== id || !STATES.has(record.state)
                || !TOKEN.test(record.tokenHash) || !TOKEN.test(record.inputHash) || !TOKEN.test(record.owner)
                || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
                || typeof record.originalPrompt !== 'string' || typeof record.size !== 'string'
                || !Number.isInteger(record.referenceCount)) throw new Error('Invalid private image job record');
            if (!TERMINAL.has(record.state)) {
                outstandingCount++;
                if (outstandingCount > queueCapacity) throw new Error('Private image job queue capacity exceeded');
            }
            if (record.state === 'queued') {
                const checked = normalize({ requestId: id, ...record.payload });
                if (checked.inputHash !== record.inputHash || checked.data.prompt !== record.originalPrompt
                    || checked.data.size !== record.size || checked.data.referenceImages.length !== record.referenceCount) {
                    throw new Error('Invalid queued image job payload');
                }
            } else if (!TERMINAL.has(record.state)) {
                await transition(record, 'interrupted', { code: 'IMAGE_JOB_INTERRUPTED',
                    error: '服务重启中断了任务，未自动重新提交。请先查看是否已生成，再决定是否手动重试；重新生成可能再次计费。' });
            } else if (record.payload) {
                delete record.payload;
                await persist(record);
            }
            records.set(id, record);
        }
        await clean();
        cleanupTimer = setInterval(() => { locked(clean).catch(() => {}); }, 60000);
        cleanupTimer.unref?.();
        schedule();
    }

    function init() {
        if (closing && !initialization) return Promise.reject(new Error('Private image job runner is closed'));
        if (!initialization) {
            if (RUNNING_DIRECTORIES.has(directory)) return Promise.reject(new Error('Private image job directory already has a runner'));
            RUNNING_DIRECTORIES.set(directory, runner);
            initialization = initialize().catch(error => {
                if (RUNNING_DIRECTORIES.get(directory) === runner) RUNNING_DIRECTORIES.delete(directory);
                throw error;
            });
        }
        return initialization;
    }

    async function createJob(payload, token, owner) {
        const normalized = normalize(payload);
        const hashedToken = tokenDigest(token);
        await init();
        return locked(async () => {
            if (closing) throw failure(503, 'IMAGE_JOB_BUSY', '后台服务正在维护，请稍后再试。');
            await clean();
            const existing = records.get(normalized.id);
            if (existing) {
                if (!authorized(existing, hashedToken)) throw failure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
                if (existing.inputHash !== normalized.inputHash) throw failure(409, 'REQUEST_ID_CONFLICT', '同一任务的内容已改变，请重新发起。');
                return snapshot(existing);
            }
            if (!getApiKey()) throw failure(503, 'IMAGE_NOT_CONFIGURED', '生图服务暂时不可用，请联系管理员。');
            const outstanding = [...records.values()].filter(record => !TERMINAL.has(record.state)).length;
            if (records.size >= capacity || outstanding >= queueCapacity) throw failure(503, 'IMAGE_JOB_BUSY', '后台任务较多，请稍后再试。');
            const ownerHash = digest(String(owner || 'unknown').slice(0, 256));
            const consume = admit(ownerHash);
            const record = { version: 1, id: normalized.id, tokenHash: hashedToken, inputHash: normalized.inputHash,
                owner: ownerHash, state: 'queued', createdAt: now(), updatedAt: now(), originalPrompt: normalized.data.prompt,
                size: normalized.data.size, referenceCount: normalized.data.referenceImages.length, payload: normalized.data };
            await persist(record);
            records.set(record.id, record);
            consume();
            const response = snapshot(record);
            schedule();
            return response;
        });
    }

    async function getJob(id, token) {
        const key = identifier(id);
        const hashedToken = tokenDigest(token);
        await init();
        return locked(async () => {
            await clean();
            const record = records.get(key);
            if (!record || !authorized(record, hashedToken)) throw failure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
            return snapshot(record);
        });
    }

    async function close({ wait = false } = {}) {
        closing = true;
        clearInterval(cleanupTimer);
        if (initialization) await initialization.catch(() => {});
        clearInterval(cleanupTimer);
        await mutation;
        const release = Promise.allSettled(workers.values()).then(() => {
            if (RUNNING_DIRECTORIES.get(directory) === runner) RUNNING_DIRECTORIES.delete(directory);
        });
        if (wait) await release;
    }

    return { init, createJob, getJob, close };
}
