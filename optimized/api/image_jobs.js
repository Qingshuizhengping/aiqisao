import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { getImageApiKey } from './image_config.js';
import { generateImageRequest, prepareImagePrompt } from './image_prompt.js';
import { imageOwnerId, imagePolicy } from './image_policy.js';
import { createImageJobStore, DEFAULT_JOB_DIRECTORY } from './image_job_store.js';
import { createImageJobRunner } from './image_job_runner.js';
import { JOB_HASH, TERMINAL_JOB_STATES, jobDigest, jobFailure, jobIdentifier, jobSnapshot, normalizeJobInput } from './image_job_record.js';

const RUNNING_DIRECTORIES = new Map();

function tokenDigest(token) {
    if (typeof token !== 'string' || !JOB_HASH.test(token)) throw jobFailure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
    return jobDigest(token.toLowerCase());
}

function authorized(record, tokenHash) {
    const stored = Buffer.from(record.tokenHash, 'hex');
    const received = Buffer.from(tokenHash, 'hex');
    return stored.length === received.length && timingSafeEqual(stored, received);
}

export function createImageJobService({ storeDirectory = DEFAULT_JOB_DIRECTORY, prepare = prepareImagePrompt,
    generate = generateImageRequest, getApiKey = getImageApiKey, now = () => Date.now(), concurrency = 2,
    capacity = 64, queueCapacity = 8, retentionMs = 24 * 3600000, policy = imagePolicy, store } = {}) {
    store ||= createImageJobStore({ directory: storeDirectory, capacity, queueCapacity, retentionMs, now });
    const directory = path.resolve(store.directory || storeDirectory);
    const records = new Map();
    let initialization;
    let initialized = false;
    let closing = false;
    let storageFailure;
    let cleanupTimer;
    let mutation = Promise.resolve();
    const runner = createImageJobRunner({ records, transition, prepare, generate, getApiKey, concurrency, onFailure: failStorage });

    function locked(operation) {
        const pending = mutation.then(operation, operation);
        mutation = pending.catch(() => {});
        return pending;
    }

    function failStorage(error) {
        storageFailure ||= Object.assign(jobFailure(503, 'IMAGE_JOB_STORAGE_UNAVAILABLE', '后台任务存储暂时不可用，请勿重新提交；恢复后请查询原任务。'), { cause: error });
        runner.pause();
        clearInterval(cleanupTimer);
        return storageFailure;
    }

    function available() {
        if (storageFailure) throw storageFailure;
    }

    async function persist(record) {
        available();
        try { await store.persist(record); } catch (error) { throw failStorage(error); }
    }

    async function clean() {
        available();
        try {
            const removed = await store.prune(records.values());
            for (const id of removed) records.delete(id);
        } catch (error) { throw failStorage(error); }
    }

    async function transition(record, state, fields = {}) {
        const updated = { ...record, ...fields, state, updatedAt: now() };
        if (TERMINAL_JOB_STATES.has(state)) delete updated.payload;
        await persist(updated);
        Object.assign(record, updated);
        if (TERMINAL_JOB_STATES.has(state)) delete record.payload;
    }

    async function initialize() {
        const restored = await store.load();
        for (const record of restored) {
            if (record.state !== 'queued' && !TERMINAL_JOB_STATES.has(record.state)) {
                await transition(record, 'interrupted', { code: 'IMAGE_JOB_INTERRUPTED',
                    error: '服务重启中断了任务，未自动重新提交。请先查看是否已生成，再决定是否手动重试；重新生成可能再次计费。' });
            } else if (TERMINAL_JOB_STATES.has(record.state) && record.payload) {
                delete record.payload;
                await persist(record);
            }
            records.set(record.id, record);
        }
        await clean();
        initialized = true;
        if (!closing) {
            cleanupTimer = setInterval(() => { locked(clean).catch(() => {}); }, 60000);
            cleanupTimer.unref?.();
            runner.schedule();
        }
    }

    function init() {
        if (closing && !initialization) return Promise.reject(new Error('Private image job runner is closed'));
        if (!initialization) {
            if (RUNNING_DIRECTORIES.has(directory)) return Promise.reject(new Error('Private image job directory already has a runner'));
            RUNNING_DIRECTORIES.set(directory, runner);
            initialization = initialize().catch(error => {
                failStorage(error);
                if (RUNNING_DIRECTORIES.get(directory) === runner) RUNNING_DIRECTORIES.delete(directory);
                throw error;
            });
        }
        return initialization;
    }

    async function ready() {
        try { await init(); } catch (error) { throw storageFailure || error; }
        available();
    }

    async function createJob(payload, token, owner) {
        const normalized = normalizeJobInput(payload);
        const hashedToken = tokenDigest(token);
        await ready();
        return locked(async () => {
            available();
            if (closing) throw jobFailure(503, 'IMAGE_JOB_BUSY', '后台服务正在维护，请稍后再试。');
            await clean();
            const existing = records.get(normalized.id);
            if (existing) {
                if (!authorized(existing, hashedToken)) throw jobFailure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
                if (existing.inputHash !== normalized.inputHash) throw jobFailure(409, 'REQUEST_ID_CONFLICT', '同一任务的内容已改变，请重新发起。');
                return jobSnapshot(existing);
            }
            if (!getApiKey()) throw jobFailure(503, 'IMAGE_NOT_CONFIGURED', '生图服务暂时不可用，请联系管理员。');
            const outstanding = [...records.values()].filter(record => !TERMINAL_JOB_STATES.has(record.state)).length;
            if (records.size >= capacity || outstanding >= queueCapacity) throw jobFailure(503, 'IMAGE_JOB_BUSY', '后台任务较多，请稍后再试。');
            const ownerHash = imageOwnerId(owner);
            const rollback = policy.reserveImage(owner);
            const record = { version: 1, id: normalized.id, tokenHash: hashedToken, inputHash: normalized.inputHash,
                owner: ownerHash, state: 'queued', createdAt: now(), updatedAt: now(), originalPrompt: normalized.data.prompt,
                size: normalized.data.size, referenceCount: normalized.data.referenceImages.length, payload: normalized.data };
            try { await persist(record); } catch (error) { rollback(); throw error; }
            records.set(record.id, record);
            available();
            const response = jobSnapshot(record);
            runner.schedule();
            return response;
        });
    }

    async function getJob(id, token) {
        const key = jobIdentifier(id);
        const hashedToken = tokenDigest(token);
        await ready();
        return locked(async () => {
            await clean();
            const record = records.get(key);
            if (!record || !authorized(record, hashedToken)) throw jobFailure(404, 'IMAGE_JOB_NOT_FOUND', '找不到生成任务或访问凭据无效。');
            return jobSnapshot(record);
        });
    }

    function health() {
        return storageFailure ? { ready: false, code: storageFailure.code, error: storageFailure.message }
            : { ready: initialized && !closing };
    }

    async function close({ wait = false } = {}) {
        closing = true;
        runner.pause();
        clearInterval(cleanupTimer);
        if (initialization) await initialization.catch(() => {});
        await mutation;
        const release = runner.close().then(() => {
            if (RUNNING_DIRECTORIES.get(directory) === runner) RUNNING_DIRECTORIES.delete(directory);
        });
        if (wait) await release;
    }

    return { init, createJob, getJob, health, close };
}
