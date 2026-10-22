import { completedJobResult, jobDigest, jobFailure } from './image_job_record.js';

export function createImageJobRunner({ records, transition, prepare, generate, getApiKey, onFailure, concurrency = 2 }) {
    const workers = new Map();
    const maximumWorkers = Math.min(2, Math.max(1, Math.floor(concurrency) || 1));
    let paused = false;
    let scheduled = false;

    async function execute(record) {
        let imageAttempted = false;
        try {
            const input = record.payload;
            const owner = { imageOwnerHash: record.owner };
            const apiKey = getApiKey();
            if (!apiKey) throw jobFailure(503, 'IMAGE_NOT_CONFIGURED', '生图服务暂时不可用，请联系管理员。');
            let prepared;
            if (input.optimize) {
                await transition(record, 'optimizing');
                prepared = await prepare({ prompt: input.prompt, size: input.size,
                    referenceHashes: input.referenceImages.map(jobDigest), requestId: record.id }, owner);
                if (prepared.status === 'needs_clarification') {
                    await transition(record, 'needs_clarification', { question: prepared.question });
                    return;
                }
                if (prepared.status !== 'ready' || !prepared.optimizationToken || prepared.originalPrompt !== input.prompt) {
                    throw jobFailure(502, 'OPTIMIZATION_UNAVAILABLE', '需求优化暂时不可用，未开始生成。');
                }
            }
            await transition(record, 'generating', prepared ? { optimization: { originalPrompt: prepared.originalPrompt,
                optimizedPrompt: prepared.optimizedPrompt, intent: prepared.intent } } : {});
            imageAttempted = true;
            const result = await generate({ prompt: input.prompt, size: input.size, referenceImages: input.referenceImages,
                requestId: record.id, ...(prepared ? { optimizationToken: prepared.optimizationToken } : {}) }, owner, apiKey, { admitted: true });
            await transition(record, 'succeeded', { result: completedJobResult(result, record) });
        } catch (error) {
            if (error?.code === 'IMAGE_JOB_STORAGE_UNAVAILABLE') throw error;
            const optimizing = record.state === 'optimizing';
            const known = typeof error?.code === 'string' && /^(?:OPTIMIZATION_|IMAGE_|REQUEST_)[A-Z_]+$/.test(error.code);
            const code = known ? error.code : imageAttempted ? 'IMAGE_GENERATION_UNKNOWN' : 'IMAGE_JOB_FAILED';
            const message = known && typeof error.message === 'string' ? error.message : imageAttempted
                ? '生成可能已提交，请勿盲目重试；如需重新生成可能再次计费。' : '生成服务暂时不可用，请稍后再试。';
            await transition(record, 'failed', { error: message.slice(0, 500), code,
                allowOriginal: Boolean(optimizing && code === 'OPTIMIZATION_UNAVAILABLE' && error.allowOriginal === true) });
        }
    }

    function pause() {
        paused = true;
    }

    function schedule() {
        if (scheduled || paused) return;
        scheduled = true;
        setImmediate(() => {
            scheduled = false;
            if (paused) return;
            for (const record of records.values()) {
                if (workers.size >= maximumWorkers) break;
                if (record.state !== 'queued' || workers.has(record.id)) continue;
                const worker = execute(record).catch(error => {
                    pause();
                    onFailure(error);
                }).finally(() => {
                    workers.delete(record.id);
                    schedule();
                });
                workers.set(record.id, worker);
            }
        });
    }

    function close() {
        pause();
        return Promise.allSettled(workers.values());
    }

    return { schedule, pause, close };
}
