import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

globalThis.fetch = () => { throw new Error('Network forbidden in job fixtures'); };
const { createImageJobService } = await import('../../api/image_jobs.js');
const { createImagePolicy } = await import('../../api/image_policy.js');
const root = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), 'background-job-fixture-'));
const services = [];
const checks = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12);
const reference = 'data:image/png;base64,' + png.toString('base64');
const token = randomBytes(32).toString('hex');
const options = { getApiKey: () => 'fixture-image-key' };
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
function service(folder, overrides = {}) {
    const instance = createImageJobService({ ...options, policy: createImagePolicy({ now: overrides.now }), storeDirectory: path.join(root, folder), ...overrides });
    services.push(instance);
    return instance;
}
async function until(operation) {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (await operation()) return;
        await sleep(5);
    }
    throw new Error('Fixture state did not settle');
}
async function errorStatus(operation, expected, code) {
    await assert.rejects(operation, error => error.status === expected && (!code || error.code === code));
}
function payload(overrides = {}) { return { requestId: randomUUID(), prompt: '玻璃杯，不要文字', size: 'auto', referenceImages: [reference], optimize: true, ...overrides }; }
async function finish(instance, input) {
    await until(async () => ['succeeded', 'failed', 'needs_clarification', 'interrupted'].includes((await instance.getJob(input.requestId, token)).job.state));
    return (await instance.getJob(input.requestId, token)).job;
}
async function record(folder, input, state) {
    const data = { prompt: input.prompt.trim(), size: input.size, referenceImages: input.referenceImages, optimize: input.optimize };
    const content = { version: 1, id: input.requestId, tokenHash: hash(token), inputHash: hash(JSON.stringify({ ...data, referenceImages: data.referenceImages.map(hash) })),
        owner: hash('fixture-owner'), state, createdAt: 10000, updatedAt: 10000, originalPrompt: input.prompt.trim(),
        size: input.size, referenceCount: input.referenceImages.length, payload: data };
    const target = path.join(root, folder);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(path.join(target, input.requestId + '.json'), JSON.stringify(content), { mode: 0o600 });
    return content;
}

try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const events = [];
    let generationInput;
    let preparationInput;
    let optimizationOwner;
    const primary = service('primary', {
        async prepare(input, owner, extra) {
            events.push('prepare');
            preparationInput = input;
            optimizationOwner = owner;
            check('background optimization has no HTTP disconnect signal', extra === undefined);
            await gate;
            return { status: 'ready', originalPrompt: input.prompt, optimizedPrompt: input.prompt + '柔和光影，清晰层次', intent: '产品视觉', optimizationToken: 'fixture-bound-optimization-token' };
        },
        async generate(input, owner, key, extra) {
            events.push('generate');
            generationInput = input;
            check('same owner and configured image key reach generation', JSON.stringify(owner) === JSON.stringify(optimizationOwner) && key === 'fixture-image-key');
            check('background generation reuses admission without an HTTP disconnect signal', extra.admitted === true && extra.signal === undefined);
            return { url: '/static/gen/fixture.png', submittedPrompt: '完整优化后的视觉描述' };
        },
    });
    const input = payload();
    const created = await primary.createJob(input, token, '203.0.113.1');
    check('create acknowledges durable queued job before optimization completion', created.job.state === 'queued');
    const storedQueued = JSON.parse(await readFile(path.join(root, 'primary', input.requestId + '.json'), 'utf8'));
    check('durable record stores capability hash rather than raw capability', storedQueued.tokenHash === hash(token) && !JSON.stringify(storedQueued).includes(token));
    check('snapshot does not leak capability, reference data, owner or input digest', !JSON.stringify(created).includes(reference) && !('tokenHash' in created.job) && !('owner' in created.job) && !('inputHash' in created.job));
    await until(() => events.length === 1);
    const duplicate = await primary.createJob(input, token, '198.51.100.9');
    check('same ID/token/content is idempotent after network changes', duplicate.job.id === input.requestId && events.length === 1);
    const polled = await primary.getJob(input.requestId, token);
    check('polling is capability based without client IP', polled.job.state === 'optimizing');
    await errorStatus(() => primary.getJob(input.requestId, randomBytes(32).toString('hex')), 404);
    await errorStatus(() => primary.createJob(input, randomBytes(32).toString('hex'), '203.0.113.1'), 404);
    check('wrong capability cannot read or replace a task', true);
    await errorStatus(() => primary.createJob({ ...input, prompt: '改变的内容' }, token, '203.0.113.1'), 409);
    check('ID collision with changed payload is rejected', true);
    check('optimized preparation gets text, ordered hashes and logical UUID only', JSON.stringify(Object.keys(preparationInput).sort()) === JSON.stringify(['prompt', 'referenceHashes', 'requestId', 'size']) && preparationInput.referenceHashes[0] === hash(reference) && preparationInput.requestId === input.requestId);
    await sleep(20);
    check('background task waits for complete optimization without early image call', events.join(',') === 'prepare');
    release();
    const completed = await finish(primary, input);
    check('optimization is followed by one generation', completed.state === 'succeeded' && events.join(',') === 'prepare,generate');
    check('generation retains ordered references, ID and signed optimization token', generationInput.requestId === input.requestId && generationInput.referenceImages[0] === reference && generationInput.optimizationToken === 'fixture-bound-optimization-token');
    check('completed snapshot retains complete optimization and image result', completed.result.url === '/static/gen/fixture.png' && completed.optimization.optimizedPrompt.endsWith('柔和光影，清晰层次'));
    const completedDisk = JSON.parse(await readFile(path.join(root, 'primary', input.requestId + '.json'), 'utf8'));
    check('terminal durable records immediately discard raw reference payload', !('payload' in completedDisk) && !JSON.stringify(completedDisk).includes(reference));
    await primary.createJob(input, token, 'changed-network');
    check('repeated completed submission cannot repeat billed generation', events.length === 2);
    const sameDirectory = createImageJobService({ ...options, storeDirectory: path.join(root, 'primary') });
    await assert.rejects(() => sameDirectory.init(), /already has a runner/);
    check('second in-process runner for same directory fails closed', true);
    await primary.close({ wait: true });

    let replayCalls = 0;
    const reloaded = service('primary', { generate: async () => { replayCalls++; } });
    await reloaded.init();
    check('restart restores completed result without resubmission', (await reloaded.getJob(input.requestId, token)).job.state === 'succeeded' && replayCalls === 0);
    await reloaded.close({ wait: true });

    const queued = payload({ optimize: false });
    await record('restart-queued', queued, 'queued');
    const queuedService = service('restart-queued', { now: () => 20000, generate: async () => { replayCalls++; return { url: '/static/gen/resumed.png' }; } });
    await queuedService.init();
    check('queued durable task resumes once after restart', (await finish(queuedService, queued)).state === 'succeeded' && replayCalls === 1);
    await queuedService.close({ wait: true });
    for (const state of ['optimizing', 'generating']) {
        const previous = payload();
        await record('restart-' + state, previous, state);
        const recovered = service('restart-' + state, { now: () => 20000, prepare: async () => { throw new Error('Must never retry'); }, generate: async () => { throw new Error('Must never retry'); } });
        await recovered.init();
        const result = (await recovered.getJob(previous.requestId, token)).job;
        check('restart marks ' + state + ' interrupted without automatic re-billing', result.state === 'interrupted' && result.code === 'IMAGE_JOB_INTERRUPTED' && !result.allowOriginal);
        const disk = JSON.parse(await readFile(path.join(root, 'restart-' + state, previous.requestId + '.json'), 'utf8'));
        check('interrupted ' + state + ' record removes reference payload', !disk.payload);
        await recovered.close({ wait: true });
    }

    let clarifyImages = 0;
    const clarify = service('clarify', { prepare: async () => ({ status: 'needs_clarification', question: '需要海报还是产品图？' }), generate: async () => { clarifyImages++; } });
    const clarifyInput = payload();
    await clarify.createJob(clarifyInput, token, 'owner');
    const clarified = await finish(clarify, clarifyInput);
    check('clarification terminates without image generation', clarified.state === 'needs_clarification' && clarified.question && clarifyImages === 0);
    await clarify.close({ wait: true });

    for (const code of ['OPTIMIZATION_UNAVAILABLE', 'OPTIMIZATION_BLOCKED']) {
        const failed = service(code, { prepare: async () => { throw Object.assign(new Error('固定安全错误'), { code, allowOriginal: true }); }, generate: async () => { throw new Error('Must never generate'); } });
        const failedInput = payload();
        await failed.createJob(failedInput, token, 'owner');
        const result = await finish(failed, failedInput);
        check(code + ' allows original only for technical optimizer failure', result.state === 'failed' && result.allowOriginal === (code === 'OPTIMIZATION_UNAVAILABLE'));
        await failed.close({ wait: true });
    }
    const unknown = service('unknown-error', { generate: async () => { throw new Error('SECRET /opt/private/reference.png'); } });
    const unknownInput = payload({ optimize: false });
    await unknown.createJob(unknownInput, token, 'owner');
    const unknownResult = await finish(unknown, unknownInput);
    check('unknown errors do not disclose secrets or private paths', unknownResult.state === 'failed' && !unknownResult.error.includes('SECRET') && !unknownResult.allowOriginal);
    await unknown.close({ wait: true });

    const largeResult = service('large-result', { generate: async () => ({ url: '/static/gen/large.png', revisedPrompt: '字'.repeat(100000), tokens: { untrusted: 'x'.repeat(10000) }, extra: reference }) });
    const largeInput = payload({ optimize: false });
    await largeResult.createJob(largeInput, token, 'owner');
    const boundedResult = await finish(largeResult, largeInput);
    check('completed provider metadata is whitelisted and bounded for durable restore', boundedResult.result.revisedPrompt.length === 4000 && boundedResult.result.tokens === 0 && !('extra' in boundedResult.result));
    check('original and submitted text are preserved despite auxiliary metadata bounds', boundedResult.result.originalPrompt === largeInput.prompt && boundedResult.result.submittedPrompt === largeInput.prompt);
    await largeResult.close({ wait: true });

    let now = 1000;
    const expiry = service('expiry', { now: () => now, retentionMs: 100, generate: async () => ({ url: '/static/gen/expiry.png' }) });
    const expiredInput = payload({ optimize: false });
    await expiry.createJob(expiredInput, token, 'owner');
    await finish(expiry, expiredInput);
    now = 1101;
    await errorStatus(() => expiry.getJob(expiredInput.requestId, token), 404);
    check('expired terminal records are removed from disk and lookup', (await readdir(path.join(root, 'expiry'))).length === 0);
    await expiry.close({ wait: true });

    let releaseBusy;
    const busyGate = new Promise(resolve => { releaseBusy = resolve; });
    const busy = service('bounded', { queueCapacity: 2, concurrency: 1, generate: async () => { await busyGate; return { url: '/static/gen/busy.png' }; } });
    const first = payload({ optimize: false });
    const second = payload({ optimize: false });
    await busy.createJob(first, token, 'owner');
    await busy.createJob(second, token, 'owner');
    await errorStatus(() => busy.createJob(payload({ optimize: false }), token, 'owner'), 503, 'IMAGE_JOB_BUSY');
    check('capacity bounds all queued and active reference payloads', true);
    releaseBusy();
    await finish(busy, first);
    await finish(busy, second);
    await busy.close({ wait: true });

    const rate = service('rate', { queueCapacity: 8, generate: async () => ({ url: '/static/gen/rate.png' }) });
    for (let index = 0; index < 5; index++) {
        const rateInput = payload({ optimize: false });
        await rate.createJob(rateInput, token, 'same-owner');
        await finish(rate, rateInput);
    }
    await errorStatus(() => rate.createJob(payload({ optimize: false }), token, 'same-owner'), 429);
    check('new task admission is limited per original owner', true);
    await rate.close({ wait: true });

    const validation = service('validation');
    await errorStatus(() => validation.createJob(payload({ referenceImages: ['https://example.invalid/private.jpg'] }), token, 'owner'), 400);
    await errorStatus(() => validation.createJob(payload({ optimize: 'true' }), token, 'owner'), 400);
    await errorStatus(() => validation.createJob(payload({ requestId: '../../escape' }), token, 'owner'), 400);
    check('invalid references, flags and IDs cannot create durable tasks', true);
    check('invalid task submission does not create private directory', !(await lstat(path.join(root, 'validation')).catch(() => null)));

    const orphanDirectory = path.join(root, 'orphan');
    await mkdir(orphanDirectory, { recursive: true });
    const temporary = randomUUID() + '.json.' + randomBytes(8).toString('hex') + '.tmp';
    await writeFile(path.join(orphanDirectory, temporary), reference);
    const orphan = service('orphan');
    await orphan.init();
    check('startup removes interrupted atomic temporary reference files', (await readdir(orphanDirectory)).length === 0);
    await orphan.close({ wait: true });

    const publicStore = service('public/jobs');
    await assert.rejects(() => publicStore.init(), /must not be publicly served/);
    check('private task store cannot be placed below public', true);
    await mkdir(path.join(root, 'link-target'));
    await symlink(path.join(root, 'link-target'), path.join(root, 'linked-var'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedStore = service('linked-var/jobs');
    await assert.rejects(() => linkedStore.init(), /directory ancestor/);
    check('symlinked private store ancestors are refused before payload writes', !(await lstat(path.join(root, 'link-target/jobs')).catch(() => null)));
    for (let index = 0; index < 3; index++) await record('overflow-restore', payload({ optimize: false }), 'queued');
    const overflowRestore = service('overflow-restore', { queueCapacity: 2 });
    await assert.rejects(() => overflowRestore.init(), /queue capacity exceeded/);
    check('restored unfinished payload count is bounded before workers start', true);

    if (process.platform !== 'win32') {
        check('private task directory has mode 700', ((await lstat(path.join(root, 'primary'))).mode & 0o777) === 0o700);
        check('private task record has mode 600', ((await lstat(path.join(root, 'primary', input.requestId + '.json'))).mode & 0o777) === 0o600);
    }
    const report = { passed: true, checks: checks.length, providerCalls: 0, failures: [], names: checks };
    console.log(JSON.stringify({ passed: true, checks: checks.length, providerCalls: 0 }));
} finally {
    for (const instance of services) await instance.close({ wait: true });
    const resolved = path.resolve(root);
    const allowed = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    if (!resolved.startsWith(allowed + path.sep) || !path.basename(resolved).startsWith('background-job-fixture-')) throw new Error('Unsafe fixture cleanup');
    await rm(resolved, { recursive: true, force: true });
}
