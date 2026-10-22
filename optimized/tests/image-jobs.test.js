import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createImageJobService } from '../api/image_jobs.js';
import { createImageJobStore } from '../api/image_job_store.js';
import { jobDigest } from '../api/image_job_record.js';
import { createImagePolicy, imageOwnerId } from '../api/image_policy.js';

globalThis.fetch = async () => { throw new Error('Real network requests are forbidden in image job tests'); };
const token = randomBytes(32).toString('hex');
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12);
const reference = 'data:image/png;base64,' + png.toString('base64');

function input(overrides = {}) {
    return { requestId: randomUUID(), prompt: '透明玻璃杯，不要文字', size: 'auto', referenceImages: [reference], optimize: false, ...overrides };
}

async function eventually(operation) {
    for (let attempt = 0; attempt < 500; attempt++) {
        const result = await operation();
        if (result) return result;
        await sleep(5);
    }
    assert.fail('Expected background state did not settle');
}

async function terminal(service, payload) {
    return eventually(async () => {
        const { job } = await service.getJob(payload.requestId, token);
        return ['succeeded', 'failed', 'needs_clarification', 'interrupted'].includes(job.state) && job;
    });
}

async function fixture(context) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiqisao-jobs-'));
    const services = [];
    const releases = [];
    context.after(async () => {
        for (const release of releases) release();
        for (const service of services) await service.close({ wait: true });
        const resolved = path.resolve(root);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('aiqisao-jobs-'));
        await rm(resolved, { recursive: true, force: true });
    });
    function service(name, overrides = {}) {
        const instance = createImageJobService({ storeDirectory: path.join(root, name),
            getApiKey: () => 'test-image-key', policy: createImagePolicy({ now: overrides.now }),
            generate: async () => ({ url: '/static/gen/test.png' }), ...overrides });
        services.push(instance);
        return instance;
    }
    function gate() {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        releases.push(release);
        return { promise, release };
    }
    async function legacyRecord(name, payload, state) {
        const directory = path.join(root, name);
        await mkdir(directory, { recursive: true });
        const data = { prompt: payload.prompt.trim(), size: payload.size, referenceImages: payload.referenceImages, optimize: payload.optimize };
        const record = { version: 1, id: payload.requestId, tokenHash: jobDigest(token),
            inputHash: jobDigest(JSON.stringify({ ...data, referenceImages: data.referenceImages.map(jobDigest) })),
            owner: jobDigest('original-owner'), state, createdAt: 1000, updatedAt: 1000,
            originalPrompt: data.prompt, size: data.size, referenceCount: data.referenceImages.length, payload: data };
        await writeFile(path.join(directory, payload.requestId + '.json'), JSON.stringify(record));
        return record;
    }
    return { root, service, gate, legacyRecord };
}

test('durable creation, capability authorization and idempotency preserve the HTTP shape', async context => {
    const fixtures = await fixture(context);
    const preparation = fixtures.gate();
    const calls = [];
    let canonicalOwner;
    let admissions = 0;
    const policy = createImagePolicy();
    const service = fixtures.service('capability', {
        policy: { reserveImage(owner) { admissions++; return policy.reserveImage(owner); } },
        async prepare(payload, owner, options) {
            calls.push('prepare');
            canonicalOwner = owner;
            assert.deepEqual(owner, { imageOwnerHash: imageOwnerId('203.0.113.1') });
            assert.equal(options, undefined);
            assert.deepEqual(payload.referenceHashes, [jobDigest(reference)]);
            assert.equal('referenceImages' in payload, false);
            await preparation.promise;
            return { status: 'ready', originalPrompt: payload.prompt, optimizedPrompt: payload.prompt + '，柔和光影',
                intent: '产品视觉', optimizationToken: 'test-bound-token' };
        },
        async generate(payload, owner, key, options) {
            calls.push('generate');
            assert.equal(owner, canonicalOwner);
            assert.equal(key, 'test-image-key');
            assert.deepEqual(options, { admitted: true });
            assert.deepEqual(payload.referenceImages, [reference]);
            assert.equal(payload.optimizationToken, 'test-bound-token');
            return { url: '/static/gen/test.png' };
        },
    });
    const payload = input({ optimize: true });
    const created = await service.createJob(payload, token, '203.0.113.1');
    assert.equal(created.status, 'ok');
    assert.equal(created.job.state, 'queued');
    const filename = path.join(fixtures.root, 'capability', payload.requestId + '.json');
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.tokenHash, jobDigest(token));
    assert.equal(JSON.stringify(stored).includes(token), false);
    for (const privateField of ['tokenHash', 'owner', 'inputHash', 'payload']) assert.equal(privateField in created.job, false);
    assert.equal(JSON.stringify(created).includes(reference), false);
    await eventually(() => calls.length === 1);
    await service.createJob(payload, token, 'changed-network');
    assert.equal(admissions, 1);
    assert.deepEqual(calls, ['prepare']);
    await assert.rejects(() => service.getJob(payload.requestId, 'a'.repeat(64)), { status: 404 });
    await assert.rejects(() => service.createJob(payload, 'a'.repeat(64), 'owner'), { status: 404 });
    await assert.rejects(() => service.createJob({ ...payload, prompt: 'different' }, token, 'owner'), { status: 409 });
    preparation.release();
    const completed = await terminal(service, payload);
    assert.equal(completed.state, 'succeeded');
    assert.deepEqual(calls, ['prepare', 'generate']);
    assert.equal(completed.result.optimization.status, 'applied');
    assert.equal(completed.result.submittedPrompt, payload.prompt + '，柔和光影');
    const completedRecord = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal('payload' in completedRecord, false);
    assert.equal(JSON.stringify(completedRecord).includes(reference), false);
    await service.createJob(payload, token, 'another-network');
    assert.equal(admissions, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(service.health(), { ready: true });
    const duplicateRunner = fixtures.service('capability');
    await assert.rejects(() => duplicateRunner.init(), /already has a runner/);
    await service.close({ wait: true });
    const restored = fixtures.service('capability', { generate() { assert.fail('Completed job cannot be replayed'); } });
    await restored.init();
    assert.deepEqual((await restored.getJob(payload.requestId, token)).job, completed);
});

test('v1 queued jobs resume but started jobs are interrupted without rebilling', async context => {
    const fixtures = await fixture(context);
    let generations = 0;
    const queued = input();
    const previous = await fixtures.legacyRecord('queued', queued, 'queued');
    const service = fixtures.service('queued', { now: () => 2000, async generate(payload, owner) {
        generations++;
        assert.deepEqual(owner, { imageOwnerHash: previous.owner });
        return { url: '/static/gen/restored.png' };
    } });
    await service.init();
    assert.equal((await terminal(service, queued)).state, 'succeeded');
    assert.equal(generations, 1);
    for (const state of ['optimizing', 'generating']) {
        const payload = input({ optimize: true });
        await fixtures.legacyRecord(state, payload, state);
        const recovered = fixtures.service(state, { now: () => 2000,
            prepare() { assert.fail('Started optimization must not replay'); },
            generate() { assert.fail('Started generation must not replay'); } });
        await recovered.init();
        const result = (await recovered.getJob(payload.requestId, token)).job;
        assert.equal(result.state, 'interrupted');
        assert.equal(result.code, 'IMAGE_JOB_INTERRUPTED');
        const disk = JSON.parse(await readFile(path.join(fixtures.root, state, payload.requestId + '.json'), 'utf8'));
        assert.equal('payload' in disk, false);
    }
});

test('business errors terminate safely and successful metadata stays bounded', async context => {
    const fixtures = await fixture(context);
    for (const code of ['OPTIMIZATION_UNAVAILABLE', 'OPTIMIZATION_BLOCKED']) {
        const payload = input({ optimize: true });
        const service = fixtures.service(code, { prepare: async () => { throw Object.assign(new Error('安全错误'), { code, allowOriginal: true }); },
            generate() { assert.fail('Optimization errors must not generate images'); } });
        await service.createJob(payload, token, 'owner');
        const result = await terminal(service, payload);
        assert.equal(result.state, 'failed');
        assert.equal(result.allowOriginal, code === 'OPTIMIZATION_UNAVAILABLE');
        assert.deepEqual(service.health(), { ready: true });
    }
    const clarification = fixtures.service('clarification', { prepare: async () => ({ status: 'needs_clarification', question: '海报还是产品图？' }),
        generate() { assert.fail('Clarification must not generate'); } });
    const unclear = input({ optimize: true });
    await clarification.createJob(unclear, token, 'owner');
    assert.equal((await terminal(clarification, unclear)).state, 'needs_clarification');
    const unknown = fixtures.service('unknown', { generate: async () => { throw new Error('SECRET /private/reference.png'); } });
    const unknownInput = input();
    await unknown.createJob(unknownInput, token, 'owner');
    const failed = await terminal(unknown, unknownInput);
    assert.equal(failed.code, 'IMAGE_GENERATION_UNKNOWN');
    assert.equal(failed.error.includes('SECRET'), false);
    const bounded = fixtures.service('bounded-result', { generate: async () => ({ url: '/static/gen/valid.png', revisedPrompt: '字'.repeat(100000), tokens: { private: true }, extra: reference }) });
    const boundedInput = input();
    await bounded.createJob(boundedInput, token, 'owner');
    const result = (await terminal(bounded, boundedInput)).result;
    assert.equal(result.revisedPrompt.length, 4000);
    assert.equal(result.tokens, 0);
    assert.equal('extra' in result, false);
});

test('concurrency, outstanding capacity, expiry and per-owner quota remain bounded', async context => {
    const fixtures = await fixture(context);
    const execution = fixtures.gate();
    let started = 0;
    const service = fixtures.service('capacity', { concurrency: 2, queueCapacity: 3, async generate() {
        started++;
        await execution.promise;
        return { url: '/static/gen/bounded.png' };
    } });
    const payloads = [input(), input(), input()];
    for (const payload of payloads) await service.createJob(payload, token, 'owner');
    await eventually(() => started === 2);
    await assert.rejects(() => service.createJob(input(), token, 'owner'), { code: 'IMAGE_JOB_BUSY' });
    assert.equal(started, 2);
    execution.release();
    for (const payload of payloads) await terminal(service, payload);
    assert.equal(started, 3);
    for (let index = 0; index < 2; index++) {
        const payload = input();
        await service.createJob(payload, token, 'owner');
        await terminal(service, payload);
    }
    await assert.rejects(() => service.createJob(input(), token, 'owner'), { status: 429 });
    let now = 1000;
    const expiry = fixtures.service('expiry', { now: () => now, retentionMs: 100 });
    const expiring = input();
    await expiry.createJob(expiring, token, 'owner');
    await terminal(expiry, expiring);
    now = 1101;
    await assert.rejects(() => expiry.getJob(expiring.requestId, token), { status: 404 });
    assert.deepEqual(await readdir(path.join(fixtures.root, 'expiry')), []);
});

test('failed initial persistence rolls back admission and fails closed', async context => {
    const fixtures = await fixture(context);
    let writes = 0;
    const policy = createImagePolicy();
    const store = createImageJobStore({ directory: path.join(fixtures.root, 'initial-failure') });
    const service = fixtures.service('initial-failure', { policy, store: { ...store,
        async persist() { writes++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
    const payload = input();
    await assert.rejects(() => service.createJob(payload, token, 'owner'), { status: 503, code: 'IMAGE_JOB_STORAGE_UNAVAILABLE' });
    assert.equal(service.health().ready, false);
    assert.equal(service.health().code, 'IMAGE_JOB_STORAGE_UNAVAILABLE');
    await assert.rejects(() => service.getJob(payload.requestId, token), { status: 503 });
    await assert.rejects(() => service.createJob(input(), token, 'owner'), { status: 503 });
    await sleep(30);
    assert.equal(writes, 1);
    for (let index = 0; index < 5; index++) policy.reserveImage('owner');
    assert.throws(() => policy.reserveImage('owner'), { status: 429 });
});

test('worker persistence failures pause the runner instead of retrying or hiding queued state', async context => {
    const fixtures = await fixture(context);
    for (const failedState of ['optimizing', 'generating', 'succeeded', 'failed']) {
        let generations = 0;
        let writes = 0;
        const store = createImageJobStore({ directory: path.join(fixtures.root, failedState) });
        const service = fixtures.service(failedState, { store: { ...store, async persist(record) {
            writes++;
            if (record.state === failedState) throw new Error('storage unavailable');
            return store.persist(record);
        } }, prepare: async payload => ({ status: 'ready', originalPrompt: payload.prompt, optimizedPrompt: payload.prompt + '，柔和光影', optimizationToken: 'test-token' }),
        async generate() {
            generations++;
            if (failedState === 'failed') throw new Error('unknown provider error');
            return { url: '/static/gen/paid.png' };
        } });
        const payload = input({ optimize: failedState === 'optimizing' });
        await service.createJob(payload, token, 'owner');
        await eventually(() => service.health().code === 'IMAGE_JOB_STORAGE_UNAVAILABLE');
        const writesAtFailure = writes;
        await sleep(50);
        assert.equal(writes, writesAtFailure);
        assert.equal(generations, ['succeeded', 'failed'].includes(failedState) ? 1 : 0);
        await assert.rejects(() => service.getJob(payload.requestId, token), { status: 503 });
        await assert.rejects(() => service.createJob(input(), token, 'new-owner'), { status: 503 });
        await service.close({ wait: true });
        if (generations) {
            const recovered = fixtures.service(failedState, { generate() { assert.fail('Submitted generation must not be replayed'); } });
            await recovered.init();
            assert.equal((await recovered.getJob(payload.requestId, token)).job.state, 'interrupted');
        }
    }
});

test('the physical directory failure regression performs one worker attempt and returns 503', async context => {
    const fixtures = await fixture(context);
    const directory = path.join(fixtures.root, 'physical');
    const backup = path.join(fixtures.root, 'physical-saved');
    let keyChecks = 0;
    let generations = 0;
    const service = fixtures.service('physical', { getApiKey() {
        keyChecks++;
        if (keyChecks === 2) {
            renameSync(directory, backup);
            writeFileSync(directory, 'storage failure fixture');
        }
        return 'test-key';
    }, async generate() { generations++; return { url: '/static/gen/unreachable.png' }; } });
    const payload = input();
    try {
        await service.createJob(payload, token, 'owner');
        await eventually(() => service.health().code === 'IMAGE_JOB_STORAGE_UNAVAILABLE');
        await sleep(150);
        assert.equal(keyChecks, 2);
        assert.equal(generations, 0);
        await assert.rejects(() => service.getJob(payload.requestId, token), { status: 503 });
    } finally {
        await service.close({ wait: true });
        if (await lstat(backup).catch(() => null)) {
            await unlink(directory);
            await rename(backup, directory);
        }
    }
});

test('cleanup storage faults degrade lookup and stop new admissions', async context => {
    const fixtures = await fixture(context);
    let broken = false;
    const store = createImageJobStore({ directory: path.join(fixtures.root, 'cleanup') });
    const service = fixtures.service('cleanup', { store: { ...store, async prune(records) {
        if (broken) throw new Error('unlink failed');
        return store.prune(records);
    } } });
    const payload = input();
    await service.createJob(payload, token, 'owner');
    await terminal(service, payload);
    broken = true;
    await assert.rejects(() => service.getJob(payload.requestId, token), { status: 503 });
    assert.equal(service.health().ready, false);
    await assert.rejects(() => service.createJob(input(), token, 'owner'), { status: 503 });
});

test('transient Windows replacement failures retry the same durable file without regenerating', async context => {
    const fixtures = await fixture(context);
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        const replacements = [];
        let generations = 0;
        const store = createImageJobStore({ directory: path.join(fixtures.root, 'transient-' + code), platform: 'win32',
            async renameImpl(temporary, target) {
                const content = await readFile(temporary, 'utf8');
                if (JSON.parse(content).state === 'succeeded') {
                    replacements.push({ temporary, target, content });
                    if (replacements.length <= 2) throw Object.assign(new Error('temporary Windows lock'), { code });
                }
                return rename(temporary, target);
            } });
        const service = fixtures.service('transient-' + code, { store, async generate() {
            generations++;
            return { url: '/static/gen/paid-once.png' };
        } });
        const payload = input();
        await service.createJob(payload, token, 'owner');
        assert.equal((await terminal(service, payload)).state, 'succeeded');
        assert.equal(generations, 1);
        assert.equal(replacements.length, 3);
        for (const replacement of replacements) assert.deepEqual(replacement, replacements[0]);
        assert.equal(service.health().ready, true);
        assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
    }
});

test('persistent Windows replacement failures stop after five attempts and degrade without rebilling', async context => {
    const fixtures = await fixture(context);
    let attempts = 0;
    let generations = 0;
    const temporaryFiles = new Set();
    const store = createImageJobStore({ directory: path.join(fixtures.root, 'permanent-replace'), platform: 'win32',
        async renameImpl(temporary, target) {
            const record = JSON.parse(await readFile(temporary, 'utf8'));
            if (record.state === 'succeeded') {
                attempts++;
                temporaryFiles.add(temporary);
                throw Object.assign(new Error('persistent Windows lock'), { code: 'EPERM' });
            }
            return rename(temporary, target);
        } });
    const service = fixtures.service('permanent-replace', { store, async generate() {
        generations++;
        return { url: '/static/gen/paid-once.png' };
    } });
    const payload = input();
    await service.createJob(payload, token, 'owner');
    await eventually(() => service.health().code === 'IMAGE_JOB_STORAGE_UNAVAILABLE');
    await sleep(50);
    assert.equal(attempts, 5);
    assert.equal(temporaryFiles.size, 1);
    assert.equal(generations, 1);
    await assert.rejects(() => service.getJob(payload.requestId, token), { status: 503 });
    await assert.rejects(() => service.createJob(input(), token, 'owner'), { status: 503 });
    const record = JSON.parse(await readFile(path.join(store.directory, payload.requestId + '.json'), 'utf8'));
    assert.equal(record.state, 'generating');
    assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
});

test('replacement retries exclude disk-full errors and non-Windows platforms', async context => {
    const fixtures = await fixture(context);
    for (const { platform, code } of [{ platform: 'win32', code: 'ENOSPC' }, { platform: 'linux', code: 'EPERM' },
        { platform: 'darwin', code: 'EBUSY' }]) {
        const name = platform + '-' + code;
        const record = await fixtures.legacyRecord(name, input(), 'queued');
        let attempts = 0;
        const store = createImageJobStore({ directory: path.join(fixtures.root, name), platform,
            async renameImpl() { attempts++; throw Object.assign(new Error('non-retryable failure'), { code }); } });
        await store.load();
        await assert.rejects(() => store.persist({ ...record, state: 'generating' }), { code });
        assert.equal(attempts, 1);
        assert.equal((await readdir(store.directory)).some(filename => filename.endsWith('.tmp')), false);
        assert.equal(JSON.parse(await readFile(path.join(store.directory, record.id + '.json'), 'utf8')).state, 'queued');
    }
});

test('private store validation, orphan cleanup and record permissions remain intact', async context => {
    const fixtures = await fixture(context);
    const invalid = fixtures.service('invalid');
    for (const overrides of [{ referenceImages: ['https://example.invalid/private.jpg'] }, { optimize: 'true' }, { requestId: '../../escape' }]) {
        await assert.rejects(() => invalid.createJob(input(overrides), token, 'owner'), { status: 400 });
    }
    assert.equal(await lstat(path.join(fixtures.root, 'invalid')).catch(() => null), null);
    const orphanDirectory = path.join(fixtures.root, 'orphan');
    await mkdir(orphanDirectory);
    await writeFile(path.join(orphanDirectory, randomUUID() + '.json.' + randomBytes(8).toString('hex') + '.tmp'), reference);
    const orphan = fixtures.service('orphan');
    await orphan.init();
    assert.deepEqual(await readdir(orphanDirectory), []);
    await assert.rejects(() => fixtures.service('public/jobs').init(), /must not be publicly served/);
    const target = path.join(fixtures.root, 'target');
    await mkdir(target);
    await symlink(target, path.join(fixtures.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => fixtures.service('linked/jobs').init(), /directory ancestor/);
    for (let index = 0; index < 3; index++) await fixtures.legacyRecord('overflow', input(), 'queued');
    await assert.rejects(() => fixtures.service('overflow', { queueCapacity: 2 }).init(), /queue capacity exceeded/);
    const payload = input();
    const corrupted = await fixtures.legacyRecord('corrupt', payload, 'queued');
    corrupted.payload.prompt = 'changed after admission';
    await writeFile(path.join(fixtures.root, 'corrupt', payload.requestId + '.json'), JSON.stringify(corrupted));
    await assert.rejects(() => fixtures.service('corrupt').init(), /Invalid queued image job payload/);
    if (process.platform !== 'win32') {
        assert.equal((await lstat(orphanDirectory)).mode & 0o777, 0o700);
        const privateInput = input();
        const privateService = fixtures.service('permissions');
        await privateService.createJob(privateInput, token, 'owner');
        await terminal(privateService, privateInput);
        assert.equal((await lstat(path.join(fixtures.root, 'permissions', privateInput.requestId + '.json'))).mode & 0o777, 0o600);
    }
});
