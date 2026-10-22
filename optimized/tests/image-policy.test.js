import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createImagePolicy, imageOwnerId } from '../api/image_policy.js';
import { createImagePromptService } from '../api/image_prompt.js';
import { createImageJobService } from '../api/image_jobs.js';

const owner = '198.51.100.42';
const internalOwner = { imageOwnerHash: imageOwnerId(owner) };

test('raw and persisted owners share one identity and budget', () => {
    const policy = createImagePolicy();
    assert.equal(imageOwnerId(internalOwner), imageOwnerId(owner));
    assert.notEqual(imageOwnerId(internalOwner), imageOwnerId(internalOwner.imageOwnerHash));
    for (let index = 0; index < 5; index++) policy.reserveImage(index % 2 ? owner : internalOwner);
    assert.throws(() => policy.reserveImage(owner), { code: 'IMAGE_RATE_LIMITED' });
    assert.throws(() => imageOwnerId({ imageOwnerHash: 'invalid' }), TypeError);
});

test('rollback releases exactly its own reservation once', () => {
    const policy = createImagePolicy({ minuteLimit: 1 });
    const rollback = policy.reserveImage(owner);
    assert.throws(() => policy.reserveImage(owner), { code: 'IMAGE_RATE_LIMITED' });
    rollback();
    policy.reserveImage(owner);
    rollback();
    assert.throws(() => policy.reserveImage(owner), { code: 'IMAGE_RATE_LIMITED' });
});

test('minute and hour budgets expire independently', () => {
    let timestamp = 0;
    const policy = createImagePolicy({ now: () => timestamp });
    for (let minute = 0; minute < 6; minute++) {
        timestamp = minute * 60000;
        for (let index = 0; index < 5; index++) policy.reserveImage(owner);
    }
    timestamp = 360000;
    assert.throws(() => policy.reserveImage(owner), { code: 'IMAGE_RATE_LIMITED' });
    timestamp = 3600000;
    policy.reserveImage(owner);
});

test('optimization has a separate shared quota and bounded owner storage', () => {
    let timestamp = 0;
    const policy = createImagePolicy({ now: () => timestamp, ownerCapacity: 1 });
    for (let index = 0; index < 5; index++) policy.consumeOptimization(index % 2 ? owner : internalOwner);
    assert.throws(() => policy.consumeOptimization(owner), { code: 'OPTIMIZATION_RATE_LIMITED' });
    policy.reserveImage(owner);
    assert.throws(() => policy.reserveImage('another-owner'), { status: 503 });
    timestamp = 3600000;
    policy.reserveImage('another-owner');
});

function modelFixture(policy) {
    const calls = { optimization: 0, image: 0 };
    const service = createImagePromptService({ policy,
        env: { PROMPT_OPTIMIZER_ENABLED: 'true', PROMPT_OPTIMIZER_API_BASE: 'https://fixture.invalid/v1',
            PROMPT_OPTIMIZER_API_KEY: 'fixture-key', PROMPT_OPTIMIZER_MODEL: 'fixture-model' },
        fetchImpl: async () => {
            calls.optimization++;
            return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                decision: 'ready', optimizedPrompt: '使用柔和侧光，背景留白，主体层次清晰。', intent: '产品视觉',
            }) } }] }));
        },
        generate: async (payload, key, options) => {
            options.beforeSubmit();
            calls.image++;
            return { url: '/static/gen/fixture.png' };
        },
    });
    return { ...service, calls };
}

async function finish(jobs, requestId, token) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const result = await jobs.getJob(requestId, token);
        if (result.job.state === 'succeeded') return result;
        assert.notEqual(result.job.state, 'failed', JSON.stringify(result));
        await delay(5);
    }
    throw new Error('Mock job did not finish');
}

for (const legacyFirst of [true, false]) {
    test('legacy and background share five admissions, legacy first: ' + legacyFirst, async () => {
        const policy = createImagePolicy();
        const model = modelFixture(policy);
        const directory = await mkdtemp(path.join(tmpdir(), 'aiqisao-policy-test-'));
        const jobs = createImageJobService({ storeDirectory: directory, policy, getApiKey: () => 'fixture-key',
            prepare: model.prepareImagePrompt, generate: model.generateImageRequest });
        const token = randomBytes(32).toString('hex');
        try {
            for (let index = 0; index < 5; index++) {
                const payload = { prompt: '玻璃杯产品图', size: 'auto', referenceHashes: [], requestId: randomUUID() };
                if ((index < 3) === legacyFirst) {
                    const prepared = await model.prepareImagePrompt(payload, owner);
                    const input = { prompt: payload.prompt, size: payload.size, requestId: payload.requestId,
                        optimizationToken: prepared.optimizationToken };
                    await model.generateImageRequest(input, owner, 'fixture-key');
                    await model.generateImageRequest(input, owner, 'fixture-key');
                } else {
                    const input = { prompt: payload.prompt, size: payload.size, requestId: payload.requestId };
                    await jobs.createJob(input, token, owner);
                    await finish(jobs, payload.requestId, token);
                    await jobs.createJob(input, token, 'changed-mobile-network');
                }
            }
            assert.deepEqual(model.calls, { optimization: 5, image: 5 });
            await assert.rejects(jobs.createJob({ prompt: 'another image', requestId: randomUUID() }, token, owner),
                { code: 'IMAGE_RATE_LIMITED' });
            await assert.rejects(model.generateImageRequest({ prompt: 'another image', requestId: randomUUID() }, owner, 'fixture-key'),
                { code: 'IMAGE_RATE_LIMITED' });
            await assert.rejects(model.prepareImagePrompt({ prompt: 'another image', requestId: randomUUID(), referenceHashes: [] }, owner),
                { code: 'OPTIMIZATION_RATE_LIMITED' });
            assert.deepEqual(model.calls, { optimization: 5, image: 5 });
        } finally {
            await jobs.close({ wait: true });
            const resolved = path.resolve(directory);
            assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
            assert.ok(path.basename(resolved).startsWith('aiqisao-policy-test-'));
            await rm(resolved, { recursive: true, force: true });
        }
    });
}
