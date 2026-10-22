import { createHash } from 'node:crypto';
import { validateImagePayload } from './image_gen.js';

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const JOB_HASH = /^[0-9a-f]{64}$/i;
export const TERMINAL_JOB_STATES = new Set(['succeeded', 'needs_clarification', 'failed', 'interrupted']);
const JOB_STATES = new Set(['queued', 'optimizing', 'generating', ...TERMINAL_JOB_STATES]);

export function jobFailure(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

export function jobDigest(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function jobIdentifier(value) {
    if (typeof value !== 'string' || !JOB_ID.test(value)) throw jobFailure(400, 'INVALID_REQUEST_ID', '请求标识无效，请重新发起。');
    return value.toLowerCase();
}

export function normalizeJobInput(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['requestId', 'prompt', 'size', 'referenceImages', 'optimize'].includes(key))
        || (payload.optimize !== undefined && typeof payload.optimize !== 'boolean')) {
        throw jobFailure(400, 'INVALID_IMAGE_INPUT', '后台生成参数无效。');
    }
    const input = validateImagePayload(payload, { strict: true, dataUrlsOnly: true });
    const id = jobIdentifier(payload.requestId);
    const data = { prompt: input.prompt, size: input.sizeKey, referenceImages: input.referenceImages, optimize: payload.optimize !== false };
    const inputHash = jobDigest(JSON.stringify({ ...data, referenceImages: data.referenceImages.map(jobDigest) }));
    return { id, data, inputHash };
}

export function validateJobRecord(record, id) {
    if (!record || record.version !== 1 || record.id !== id || !JOB_STATES.has(record.state)
        || !JOB_HASH.test(record.tokenHash) || !JOB_HASH.test(record.inputHash) || !JOB_HASH.test(record.owner)
        || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
        || typeof record.originalPrompt !== 'string' || typeof record.size !== 'string'
        || !Number.isInteger(record.referenceCount)) throw new Error('Invalid private image job record');
    if (record.state === 'queued') {
        const checked = normalizeJobInput({ requestId: id, ...record.payload });
        if (checked.inputHash !== record.inputHash || checked.data.prompt !== record.originalPrompt
            || checked.data.size !== record.size || checked.data.referenceImages.length !== record.referenceCount) {
            throw new Error('Invalid queued image job payload');
        }
    }
}

export function jobSnapshot(record) {
    const job = { id: record.id, state: record.state, createdAt: record.createdAt, updatedAt: record.updatedAt,
        originalPrompt: record.originalPrompt, size: record.size, referenceCount: record.referenceCount };
    for (const name of ['optimization', 'result', 'question', 'error', 'code', 'allowOriginal']) {
        if (record[name] !== undefined) job[name] = record[name];
    }
    return { status: 'ok', job: JSON.parse(JSON.stringify(job)) };
}

export function completedJobResult(result, record) {
    if (!result || typeof result.url !== 'string' || !/^\/static\/gen\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/.test(result.url)) {
        throw jobFailure(502, 'IMAGE_GENERATION_UNKNOWN', '生成结果未能保存，请勿盲目重试；重新生成可能再次计费。');
    }
    const optimizedPrompt = record.optimization?.optimizedPrompt || '';
    return { url: result.url, revisedPrompt: typeof result.revisedPrompt === 'string' ? result.revisedPrompt.slice(0, 4000) : '',
        tokens: typeof result.tokens === 'number' && Number.isFinite(result.tokens) && result.tokens >= 0 ? result.tokens : 0,
        originalPrompt: record.originalPrompt, optimizedPrompt, submittedPrompt: optimizedPrompt || record.originalPrompt,
        optimization: { status: optimizedPrompt ? 'applied' : 'disabled' } };
}
