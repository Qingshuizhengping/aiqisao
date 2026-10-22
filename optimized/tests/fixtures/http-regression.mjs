import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { createImageJobService } from '../../api/image_jobs.js';
import { createImagePromptService } from '../../api/image_prompt.js';
import { createImagePolicy } from '../../api/image_policy.js';
import { createImageJobStore } from '../../api/image_job_store.js';
const policy = createImagePolicy();

const source = await readFile(new URL('../../server.js', import.meta.url), 'utf8');
const directory = await mkdtemp(new URL('./job-http-fixture-', import.meta.url));
const diskStore = createImageJobStore({ directory });
let storeUnavailable = false;
const intervals = [];
const checks = [];
const token = randomBytes(32).toString('hex');
const input = { requestId: randomUUID(), prompt: '玻璃杯，米白背景，不要人物和文字', size: 'auto', optimize: true };
let backend;
let manager;
let releaseOptimization;
let releaseGeneration;
let optimizerCalls = 0;
let imageCalls = 0;
let actualSubmittedPrompt;
const optimizationGate = new Promise(resolve => { releaseOptimization = resolve; });
const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
const service = createImagePromptService({ policy, env: { PROMPT_OPTIMIZER_ENABLED: 'true', PROMPT_OPTIMIZER_MODEL: 'fixture-optimizer', PROMPT_OPTIMIZER_API_BASE: 'https://fixture.invalid/v1' },
    getChatApiKey: () => 'fixture-key', async fetchImpl(url, options) {
        optimizerCalls++;
        assert.equal(JSON.parse(options.body).model, 'fixture-optimizer');
        await optimizationGate;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'ready', optimizedPrompt: '以柔和侧光展示通透质感，主体清晰，背景留白。', intent: '产品视觉展示' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    },
    async generate(payload, apiKey, options) {
        options.beforeSubmit();
        imageCalls++;
        actualSubmittedPrompt = payload.prompt;
        await generationGate;
        return { url: '/static/gen/job-fixture.png', revisedPrompt: '', tokens: 0 };
    },
});

function fixtureExpress() {
    const app = express();
    const get = app.get.bind(app);
    app.get = (route, ...handlers) => get(Object.prototype.toString.call(route) === '[object RegExp]' ? new RegExp(route.source, route.flags) : route, ...handlers);
    const listen = app.listen.bind(app);
    app.listen = (...argumentsList) => { backend = listen(0, '127.0.0.1', ...argumentsList.filter(value => typeof value === 'function')); return backend; };
    return app;
}
fixtureExpress.json = express.json;
const context = vm.createContext({ express: fixtureExpress, createReadStream, statSync, once, path, fileURLToPath,
    process: { env: { PORT: '0' }, exit() { throw new Error('Fixture service failed initialization'); } }, console: { log() {}, error() {} },
    API_BASE: 'https://fixture.invalid/v1', MODEL: 'fixture-chat', MAX_TOKENS: 2048, TEMPERATURE: 0.5,
    IMAGE_MODEL: 'fixture-image', getImageApiKey: () => 'fixture-image-key', getApiKey: () => 'fixture-key', renderMarkdown: value => value,
    buildMessages() { throw new Error('No chat fixture calls allowed'); },
    createImageJobService: options => {
        manager = createImageJobService({ ...options, policy, storeDirectory: directory,
            store: { ...diskStore, async prune(records) {
                if (storeUnavailable) throw new Error('private fixture storage failure');
                return diskStore.prune(records);
            } }, prepare: service.prepareImagePrompt, generate: service.generateImageRequest });
        return manager;
    },
    ...service, fetch() { throw new Error('Real network/provider calls forbidden'); }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval: (...argumentsList) => { const timer = setInterval(...argumentsList); intervals.push(timer); return timer; }, clearInterval,
});

function check(name, condition) { assert.ok(condition, name); checks.push(name); }
async function request(method, route, body, capability = token, headers = {}) {
    return new Promise((resolve, reject) => {
        const connection = http.request({ host: '127.0.0.1', port: backend.address().port, method, path: route, agent: false,
            headers: { ...(capability ? { Authorization: 'Bearer ' + capability } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                resolve({ status: response.statusCode, headers: response.headers, data: (() => { try { return JSON.parse(text); } catch { return text; } })() });
            });
        });
        connection.on('error', reject);
        connection.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
}
async function until(operation) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (await operation()) return;
        await sleep(5);
    }
    throw new Error('HTTP fixture state timeout');
}

try {
    vm.runInContext(source.replace(/^import .+;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../../server.js', import.meta.url).href)), context);
    await once(backend, 'listening');
    await until(async () => (await request('GET', '/api/health')).data.imageJobsReady === true);
    const created = await request('POST', '/api/image/jobs', input);
    check('HTTP create returns durable 202 before optimizer completion', created.status === 202 && created.data.job.state === 'queued' && imageCalls === 0);
    check('creation and polling disable caching', created.headers['cache-control'] === 'no-store' && (await request('GET', '/api/image/jobs/' + input.requestId)).headers['cache-control'] === 'no-store');
    backend.closeAllConnections();
    await until(() => optimizerCalls === 1);
    check('all client sockets can disappear while optimization continues', (await request('GET', '/api/image/jobs/' + input.requestId, undefined, token, { 'X-Forwarded-For': '198.51.100.20' })).data.job.state === 'optimizing' && imageCalls === 0);
    const duplicate = await request('POST', '/api/image/jobs', input, token, { 'X-Forwarded-For': '203.0.113.10' });
    check('re-submission after ambiguous connection uses same task without duplicate optimizer calls', duplicate.status === 202 && duplicate.data.job.id === input.requestId && optimizerCalls === 1);
    check('wrong or absent capability cannot poll task', (await request('GET', '/api/image/jobs/' + input.requestId, undefined, '')).status === 404 && (await request('GET', '/api/image/jobs/' + input.requestId, undefined, randomBytes(32).toString('hex'))).status === 404);
    const changed = await request('POST', '/api/image/jobs', { ...input, prompt: '不同主体' });
    check('changed logical request input is HTTP409', changed.status === 409 && changed.data.code === 'REQUEST_ID_CONFLICT');
    releaseOptimization();
    await until(() => imageCalls === 1);
    backend.closeAllConnections();
    const generating = await request('GET', '/api/image/jobs/' + input.requestId, undefined, token, { 'X-Forwarded-For': '192.0.2.20' });
    check('network changes during generation do not break access', generating.status === 200 && generating.data.job.state === 'generating');
    check('actual generator receives original requirements plus full optimized visual prompt', actualSubmittedPrompt.startsWith(input.prompt) && actualSubmittedPrompt.endsWith('以柔和侧光展示通透质感，主体清晰，背景留白。'));
    check('optimization snapshot is complete but does not expose signed token', generating.data.job.optimization.optimizedPrompt === actualSubmittedPrompt && !JSON.stringify(generating.data).includes('optimizationToken'));
    releaseGeneration();
    let completed;
    await until(async () => { completed = await request('GET', '/api/image/jobs/' + input.requestId); return completed.data.job.state === 'succeeded'; });
    check('background result returns through reconnect without another model request', completed.data.job.result.url === '/static/gen/job-fixture.png' && optimizerCalls === 1 && imageCalls === 1);
    await request('POST', '/api/image/jobs', input);
    check('HTTP duplicate completed submit cannot re-bill', optimizerCalls === 1 && imageCalls === 1);
    const invalid = await request('POST', '/api/image/jobs', '{"broken":');
    check('malformed job JSON returns safe JSON400', invalid.status === 400 && invalid.data.code === 'INVALID_IMAGE_INPUT');
    const oversized = await request('POST', '/api/image/jobs', { ...input, requestId: randomUUID(), padding: 'x'.repeat(1100000) });
    check('job parser accepts reference-sized transport before rejecting invalid inputs without calls', oversized.status === 400 && optimizerCalls === 1 && imageCalls === 1);
    const privateResult = await request('GET', '/var/image-jobs/' + input.requestId + '.json');
    check('private task payloads are not statically served', [403, 404].includes(privateResult.status));
    storeUnavailable = true;
    const unavailable = await request('GET', '/api/image/jobs/' + input.requestId);
    check('storage failure is explicit over HTTP rather than an endless queued state', unavailable.status === 503
        && unavailable.data.code === 'IMAGE_JOB_STORAGE_UNAVAILABLE' && !JSON.stringify(unavailable.data).includes('private fixture'));
    const unhealthy = await request('GET', '/api/health');
    check('health reports paused background jobs after storage failure', unhealthy.data.imageJobsReady === false
        && unhealthy.data.imageJobsStatus.code === 'IMAGE_JOB_STORAGE_UNAVAILABLE');
    const refused = await request('POST', '/api/image/jobs', { ...input, requestId: randomUUID() });
    check('degraded service refuses new jobs without another model call', refused.status === 503 && optimizerCalls === 1 && imageCalls === 1);
    console.log(JSON.stringify({ passed: true, checks: checks.length, providerCalls: 0, fixtureOptimizerCalls: optimizerCalls, fixtureImageCalls: imageCalls }));
} finally {
    releaseOptimization();
    releaseGeneration();
    await manager?.close({ wait: true });
    for (const timer of intervals) clearInterval(timer);
    backend?.closeAllConnections();
    if (backend) await new Promise(resolve => backend.close(resolve));
    const resolved = path.resolve(directory);
    const allowed = path.dirname(fileURLToPath(import.meta.url));
    if (!resolved.startsWith(allowed + path.sep) || !path.basename(resolved).startsWith('job-http-fixture-')) throw new Error('Unsafe HTTP fixture cleanup');
    await rm(resolved, { recursive: true, force: true });
}
