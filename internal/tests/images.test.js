import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture, eventually } from './helpers/application.js';
import { openDatabase } from '../lib/database.js';
import { createApplication } from '../server.js';
import { resolveSize, SIZE_KEYS } from '../lib/image-sizes.js';
import { downloadName } from '../lib/images.js';
import { IMAGE_MESSAGES, imageDimensions, sniffImage } from '../lib/image-upstream.js';
import { RATE_LIMIT_MESSAGE } from '../lib/image-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------- fixtures

/** A structurally valid PNG header (33 bytes) with the given pixel dimensions. */
function png(width = 1536, height = 2048) {
    const buffer = Buffer.alloc(33);
    buffer.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

/** Upstream double: always returns a base64 PNG through the `choices[].delta.image` path. */
function okTransport({ width = 1536, height = 2048 } = {}) {
    const calls = [];
    const implementation = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? String(options.body) : '' });
        return { ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ choices: [{ delta: { image: { b64_json: png(width, height).toString('base64') } } }] }) };
    };
    implementation.calls = calls;
    return implementation;
}

/** Upstream double that answers one fixed HTTP status (and optional error body). */
function statusTransport(status, body = {}) {
    const calls = [];
    const implementation = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        return { ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    implementation.calls = calls;
    return implementation;
}

/** Upstream double whose first call blocks until `release()` is called. */
function gatedTransport({ width = 1536, height = 2048 } = {}) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const implementation = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        await gate;
        return { ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ data: [{ b64_json: png(width, height).toString('base64') }] }) };
    };
    implementation.calls = calls;
    implementation.release = () => release();
    return implementation;
}

const configured = { imageApiKey: 'fixture-image-key' };

/** Submits one job and returns the parsed response. */
function submit(f, person, body) {
    return person.call('POST', '/api/images/jobs', { prompt: '产品平铺，浅色背景', requestId: randomUUID(), ...body });
}

async function finished(f, person, id, timeout = 8000) {
    return eventually(async () => {
        const response = await person.call('GET', '/api/images/jobs/' + id);
        return response.status === 200 && !['queued', 'running'].includes(response.body.job.state) ? response.body.job : null;
    }, timeout);
}

/** Binary GET (the helpers' call() parses JSON, which would corrupt image bytes). */
function rawGet(f, client, route) {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: f.port, path: route, method: 'GET', headers: client.headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                let body;
                try { body = JSON.parse(buffer.toString('utf8')); } catch { body = buffer; }
                resolve({ status: response.statusCode, body, bytes: buffer, headers: response.headers });
            });
        });
        request.on('error', reject);
        request.end();
    });
}

function manualConfig(directory) {
    return {
        origin: 'https://internal.test', host: '127.0.0.1', port: 0, cookieName: 'test_internal', secureCookies: false,
        sessionTtlMs: 3600000, encryptionKey: Buffer.alloc(32, 7), bootstrapUsername: 'admin', bootstrapPassword: '',
        chatModel: 'mock-chat', memoryModel: 'mock-memory', embeddingModel: 'mock-embed', apiKey: 'mock-key',
        chatConcurrency: 2, chatQueueCapacity: 32, contextCharacters: 48000, memoryContextCharacters: 9000,
        groundingMode: 'free', chatBreakerCooldownMs: 80,
        imageApiBase: 'https://image.test/v1/wand/hunyuan-image/v35-generation', imageApiKey: 'fixture-image-key',
        imageModel: 'hy-image-v3.5-preview', imageTimeoutMs: 5000, imageConcurrency: 2, imageQueueCapacity: 8,
        imageMinuteLimit: 5, imageHourLimit: 30, imagePromptCharacters: 4000, imageMaxBytes: 20971520,
        dataDirectory: directory, imageDirectory: path.join(directory, 'images'),
    };
}

function seedUser(db, name, role = 'member') {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,search_enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?)`).run(id, name, name, 'unused-test-password', role, now, now);
    return id;
}

// ---------------------------------------------------------------- sizes

test('all six size presets resolve and only auto omits the upstream size field', async context => {
    const expected = { '1:1': '2048x2048', '3:4': '1536x2048', '4:3': '2048x1536', '9:16': '1152x2048', '16:9': '2048x1152' };
    for (const [key, size] of Object.entries(expected)) assert.equal(resolveSize(key), size);
    assert.equal(resolveSize('auto'), null);
    assert.equal(resolveSize(undefined), '2048x2048', 'the default preset is 1:1');
    assert.deepEqual([...SIZE_KEYS], ['1:1', '3:4', '4:3', '9:16', '16:9', 'auto']);

    const fetchImpl = okTransport();
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl });
    const person = f.employee('image_sizes');
    const options = await person.call('GET', '/api/images/options');
    assert.equal(options.status, 200);
    assert.equal(options.body.enabled, true);
    assert.deepEqual(options.body.sizes.map(entry => entry.key), [...SIZE_KEYS]);
    assert.equal(options.body.limits.prompt, 4000);
    assert.equal(options.body.limits.minute, 60);

    for (const key of SIZE_KEYS) {
        const created = await submit(f, person, { size: key });
        assert.equal(created.status, 202, key + ': ' + JSON.stringify(created.body));
        await finished(f, person, created.body.job.id);
    }
    const bodies = fetchImpl.calls.map(call => JSON.parse(call.body));
    assert.equal(bodies.length, 6);
    for (const [index, key] of SIZE_KEYS.entries()) {
        if (key === 'auto') assert.equal(bodies[index].size, undefined, 'auto must not send size');
        else assert.equal(bodies[index].size, expected[key]);
        assert.equal(bodies[index].model, 'hy-image-v3.5-preview');
        assert.deepEqual(Object.keys(bodies[index]).sort(), key === 'auto' ? ['messages', 'model'] : ['messages', 'model', 'size']);
        assert.equal(bodies[index].messages[0].role, 'user');
        assert.equal(bodies[index].messages[0].content[0].type, 'text');
    }
});

test('invalid sizes, blank prompts, unknown keys and malformed request ids are rejected', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const person = f.employee('image_invalid');
    const cases = [
        [{ size: '2:1' }, 'unsupported ratio'],
        [{ size: '2048x2048' }, 'raw dimensions are not accepted'],
        [{ prompt: '   ' }, 'blank prompt'],
        [{ prompt: 'x'.repeat(4001) }, 'prompt over 4000 characters'],
        [{ prompt: 42 }, 'non string prompt'],
        [{ requestId: 'not-a-uuid' }, 'malformed request id'],
        [{ extra: true }, 'unknown key'],
    ];
    for (const [override, label] of cases) {
        const response = await submit(f, person, override);
        assert.equal(response.status, 400, label + ' -> ' + JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'INVALID_IMAGE_INPUT', label);
    }
    // A 7th size key outside the whitelist must never reach the upstream.
    const seventh = await submit(f, person, { size: '4:5' });
    assert.equal(seventh.status, 400);
    assert.equal((await person.call('GET', '/api/images/jobs')).body.jobs.length, 0, 'nothing was stored');
});

// ---------------------------------------------------------------- idempotency

test('the same requestId reuses a job, and the same key with different content conflicts', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const person = f.employee('image_idempotent');
    const requestId = randomUUID();
    const first = await submit(f, person, { requestId, prompt: '门店场景，午后自然光' });
    assert.equal(first.status, 202);
    const reused = await submit(f, person, { requestId, prompt: '门店场景，午后自然光' });
    assert.equal(reused.status, 200);
    assert.equal(reused.body.reused, true);
    assert.equal(reused.body.job.id, first.body.job.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM image_jobs').get().count, 1);

    const conflict = await submit(f, person, { requestId, prompt: '换一个完全不同的描述' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IMAGE_REQUEST_ID_CONFLICT');
    const sizeConflict = await submit(f, person, { requestId, prompt: '门店场景，午后自然光', size: '9:16' });
    assert.equal(sizeConflict.status, 409, 'changing the size is a different request');
});

// ---------------------------------------------------------------- limits

test('a member may generate five images a minute and the sixth is rate limited', async context => {
    const f = await fixture(context, { config: { ...configured }, fetchImpl: okTransport() });
    const person = f.employee('image_rate_limit');
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await submit(f, person);
        assert.equal(response.status, 202, 'attempt ' + attempt + ': ' + JSON.stringify(response.body));
    }
    // Wait for the queue to drain so this test isolates the rate limit, not queue capacity.
    await eventually(() => f.images.health().pending === 0, 8000);
    const limited = await submit(f, person);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'IMAGE_RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1, 'Retry-After must be present');
    assert.equal(limited.body.error.message, RATE_LIMIT_MESSAGE);
    const other = f.employee('image_rate_limit_other');
    assert.equal((await submit(f, other)).status, 202, 'limits are per member');
});

test('the waiting queue is bounded and reports IMAGE_QUEUE_FULL beyond capacity', async context => {
    const fetchImpl = gatedTransport();
    const f = await fixture(context, { config: { ...configured, imageConcurrency: 1, imageQueueCapacity: 2, imageMinuteLimit: 60 }, fetchImpl });
    const person = f.employee('image_queue');
    const created = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await submit(f, person);
        assert.equal(response.status, 202, 'attempt ' + attempt);
        created.push(response.body.job.id);
    }
    // One running + two waiting == capacity; the fourth must be refused.
    const rejected = await submit(f, person);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.error.code, 'IMAGE_QUEUE_FULL');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE state='queued'").get().count, 2);
    fetchImpl.release();
    for (const id of created) assert.equal((await finished(f, person, id)).state, 'succeeded');
});

// ---------------------------------------------------------------- upstream failures

test('five upstream failure classes produce five distinct codes and user texts', async context => {
    const classes = [
        [402, { error: { code: '401007', message: 'postpaid required' } }, 'IMAGE_UPSTREAM_QUOTA'],
        [401, { error: { code: 'auth_failed' } }, 'IMAGE_UPSTREAM_AUTH'],
        [422, { error: { code: 'content_filter' } }, 'IMAGE_CONTENT_BLOCKED'],
        [429, { error: { code: 'rate_limited' } }, 'IMAGE_UPSTREAM_BUSY'],
        [500, { error: { code: 'internal' } }, 'IMAGE_UPSTREAM_ERROR'],
    ];
    const messages = new Set();
    for (const [status, body, code] of classes) {
        const fetchImpl = statusTransport(status, body);
        const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl });
        const person = f.employee('image_failure_' + status);
        const created = await submit(f, person);
        assert.equal(created.status, 202);
        const job = await finished(f, person, created.body.job.id);
        assert.equal(job.state, 'failed', code);
        assert.equal(job.error.code, code);
        assert.equal(job.image, null);
        assert.equal(fetchImpl.calls.length, 1, code + ': exactly one upstream call, no retries');
        // The upstream body must never leak to the member.
        assert.doesNotMatch(job.error.message, /postpaid|auth_failed|content_filter|rate_limited|internal/);
        messages.add(job.error.message);
    }
    assert.equal(messages.size, 5, 'all five user texts are distinct');
    for (const code of ['IMAGE_UPSTREAM_QUOTA', 'IMAGE_UPSTREAM_AUTH', 'IMAGE_CONTENT_BLOCKED', 'IMAGE_UPSTREAM_BUSY', 'IMAGE_UPSTREAM_ERROR']) {
        assert.equal(typeof IMAGE_MESSAGES[code], 'string');
        assert.ok(IMAGE_MESSAGES[code].length > 0);
    }
});

test('a dropped connection marks the result unknown and is never retried automatically', async context => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
    };
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl });
    const person = f.employee('image_result_unknown');
    const created = await submit(f, person);
    assert.equal(created.status, 202);
    const job = await finished(f, person, created.body.job.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'IMAGE_RESULT_UNKNOWN');
    assert.match(job.error.message, /可能已经生成并计费/);
    assert.equal(calls.length, 1, 'no automatic retry: the image may already be billed');
});

// ---------------------------------------------------------------- isolation & history

test('a member only ever sees their own images', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const alice = f.employee('image_owner_alice');
    const bob = f.employee('image_owner_bob');
    const mine = [];
    for (let index = 0; index < 3; index += 1) {
        const created = await submit(f, alice, { prompt: 'A 的素材 ' + index });
        mine.push(created.body.job.id);
    }
    const bobs = await submit(f, bob, { prompt: 'B 的素材' });
    for (const id of mine) await finished(f, alice, id);
    await finished(f, bob, bobs.body.job.id);

    assert.equal((await alice.call('GET', '/api/images/jobs')).body.jobs.length, 3);
    assert.equal((await bob.call('GET', '/api/images/jobs')).body.jobs.length, 1);
    assert.deepEqual((await bob.call('GET', '/api/images/jobs')).body.jobs.map(job => job.prompt), ['B 的素材']);
    for (const id of mine) {
        assert.equal((await bob.call('GET', '/api/images/jobs/' + id)).status, 404);
        assert.equal((await rawGet(f, bob, '/api/images/jobs/' + id + '/content')).status, 404);
    }
    assert.equal((await alice.call('GET', '/api/images/jobs/' + bobs.body.job.id)).status, 404);
});

test('history and files survive a full service restart on the same database file', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-images-restart-'));
    const config = manualConfig(directory);
    const file = path.join(directory, 'internal.sqlite');
    const provider = { async *chat() { yield 'x'; }, async embed(texts) { return texts.map(() => [1]); } };
    let userId;
    let jobId;
    let first;
    try {
        const db = openDatabase(file);
        userId = seedUser(db, 'restart_owner');
        first = createApplication({ config, database: db, provider, fetchImpl: okTransport() });
        await first.startServices();
        const row = first.images.store.insert({ userId, requestId: randomUUID(),
            inputHash: 'hash-1', prompt: '重启前生成的素材', sizeKey: '3:4' });
        jobId = row.id;
        first.images.runner.schedule();
        await eventually(() => first.images.store.find(jobId)?.state === 'succeeded', 8000);
        const before = first.images.store.find(jobId);
        assert.ok(before.file_name, 'the file name is persisted');
        assert.equal(fs.existsSync(path.join(config.imageDirectory, before.file_name)), true);
        await first.close();
        db.close();

        const reopened = openDatabase(file);
        const second = createApplication({ config, database: reopened, provider, fetchImpl: statusTransport(500) });
        await second.startServices();
        const row2 = second.images.store.findOwned(jobId, userId);
        assert.equal(row2.state, 'succeeded', 'history is read back from SQLite');
        assert.equal(row2.file_name, before.file_name);
        const bytes = await fsp.readFile(path.join(config.imageDirectory, row2.file_name));
        assert.deepEqual(bytes, png(1536, 2048), 'the stored file is still downloadable after restart');
        await second.close();
        reopened.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a restart repairs interrupted and never submitted jobs instead of spinning forever', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-images-repair-'));
    const config = manualConfig(directory);
    const file = path.join(directory, 'internal.sqlite');
    const provider = { async *chat() { yield 'x'; }, async embed(texts) { return texts.map(() => [1]); } };
    try {
        const db = openDatabase(file);
        const userId = seedUser(db, 'repair_owner');
        const first = createApplication({ config, database: db, provider, fetchImpl: okTransport() });
        await first.startServices();
        const running = first.images.store.insert({ userId, requestId: randomUUID(), inputHash: 'h1', prompt: '执行中被重启', sizeKey: '1:1' });
        const queued = first.images.store.insert({ userId, requestId: randomUUID(), inputHash: 'h2', prompt: '排队中被重启', sizeKey: '1:1' });
        // Freeze both rows in the states a crash would leave behind.
        db.prepare("UPDATE image_jobs SET state='running' WHERE id=?").run(running.id);
        await first.close();
        db.close();

        const reopened = openDatabase(file);
        const second = createApplication({ config, database: reopened, provider, fetchImpl: okTransport() });
        // startServices() also drains the queue, so the queued probe is claimed by a worker.
        const repaired = second.images.start();
        assert.equal(repaired.interrupted, 1);
        const interrupted = second.images.store.find(running.id);
        assert.equal(interrupted.state, 'failed');
        assert.equal(interrupted.error_code, 'IMAGE_JOB_INTERRUPTED');
        assert.match(interrupted.error_message, /重启/);
        assert.equal(second.images.store.find(queued.id).state, 'failed');
        assert.equal(second.images.store.find(queued.id).error_code, 'IMAGE_JOB_CANCELLED');
        await second.close();
        reopened.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- content delivery

test('downloads carry an inline-safe cache policy and a readable file name without the prompt', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport({ width: 1536, height: 2048 }) });
    const person = f.employee('image_download');
    const prompt = '绝密新品海报草稿';
    const created = await submit(f, person, { prompt, size: '3:4' });
    const job = await finished(f, person, created.body.job.id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.image.mime, 'image/png');
    assert.equal(job.image.width, 1536);
    assert.equal(job.image.height, 2048);
    assert.equal(job.image.bytes, 33);
    assert.match(job.image.fileName, /^素材-3比4-/);
    assert.doesNotMatch(job.image.fileName, /绝密|海报草稿/);
    assert.match(job.image.fileName, /^素材-3比4-\d{8}-\d{4}\.png$/);
    assert.equal(job.image.url, '/api/images/jobs/' + job.id + '/content?v=' + job.updatedAt);

    const content = await rawGet(f, person, job.image.url);
    assert.equal(content.status, 200);
    assert.equal(content.headers['content-type'], 'image/png');
    assert.equal(content.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.ok(content.headers.etag);
    const disposition = content.headers['content-disposition'];
    assert.match(disposition, /^attachment; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), job.image.fileName);
    assert.doesNotMatch(disposition, /%E7%BB%9D%E5%AF%86/, 'the prompt must never appear in the header');
    assert.deepEqual(content.bytes, png(1536, 2048));
    assert.deepEqual(sniffImage(content.bytes), { extension: 'png', mime: 'image/png' });
    assert.deepEqual(imageDimensions(content.bytes, 'png'), { width: 1536, height: 2048 });
    // The audit trail never records the prompt either.
    const audit = f.db.prepare('SELECT details FROM audit_records').all();
    assert.equal(JSON.stringify(audit).includes(prompt), false);
});

test('images live outside dist so a rebuild cannot delete them', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const person = f.employee('image_build_safe');
    const created = await submit(f, person);
    const job = await finished(f, person, created.body.job.id);
    const stored = path.join(f.config.imageDirectory, f.images.store.find(job.id).file_name);
    assert.equal(fs.existsSync(stored), true);
    const dist = path.resolve(root, 'dist');
    assert.equal(stored.startsWith(dist + path.sep), false, 'generated images must not live under dist/');
    // The static handler only serves dist/, so the image is unreachable by its raw file name.
    const direct = await rawGet(f, person, '/' + path.basename(stored));
    assert.equal(direct.status, 404);
    // ...while the controlled route keeps working.
    assert.equal((await rawGet(f, person, job.image.url)).status, 200);
});

test('content is refused before the image exists and reported missing when the file disappears', async context => {
    const fetchImpl = gatedTransport();
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl });
    const person = f.employee('image_not_ready');
    const created = await submit(f, person);
    const pending = await rawGet(f, person, '/api/images/jobs/' + created.body.job.id + '/content');
    assert.equal(pending.status, 409);
    assert.equal(pending.body.error.code, 'IMAGE_NOT_READY');
    fetchImpl.release();
    const job = await finished(f, person, created.body.job.id);
    assert.equal(job.state, 'succeeded');

    fs.rmSync(path.join(f.config.imageDirectory, f.images.store.find(job.id).file_name));
    const missing = await rawGet(f, person, job.image.url);
    assert.equal(missing.status, 410);
    assert.equal(missing.body.error.code, 'IMAGE_FILE_MISSING');
});

test('without an API key the panel is disabled and submissions answer IMAGE_NOT_CONFIGURED', async context => {
    const fetchImpl = okTransport();
    const f = await fixture(context, { fetchImpl });
    const person = f.employee('image_not_configured');
    const options = await person.call('GET', '/api/images/options');
    assert.equal(options.status, 200);
    assert.equal(options.body.enabled, false);
    const response = await submit(f, person);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'IMAGE_NOT_CONFIGURED');
    assert.equal(fetchImpl.calls.length, 0, 'nothing is sent upstream without a key');
    assert.equal((await person.call('GET', '/api/health')).body.images.enabled, false);
});

test('an upstream auth failure is never surfaced as 401 so the member is not logged out', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: statusTransport(401, { error: { code: 'auth_failed' } }) });
    const person = f.employee('image_auth_failure');
    const statuses = [];
    const created = await submit(f, person);
    statuses.push(created.status);
    const job = await finished(f, person, created.body.job.id);
    const poll = await person.call('GET', '/api/images/jobs/' + created.body.job.id);
    statuses.push(poll.status);
    statuses.push((await rawGet(f, person, '/api/images/jobs/' + created.body.job.id + '/content')).status);
    statuses.push((await person.call('GET', '/api/auth/me')).status);
    assert.equal(job.error.code, 'IMAGE_UPSTREAM_AUTH');
    assert.equal(job.error.message, IMAGE_MESSAGES.IMAGE_UPSTREAM_AUTH);
    assert.deepEqual(statuses, [202, 200, 409, 200], 'no route answers 401 for an upstream credential problem');
});

// ---------------------------------------------------------------- pagination

test('history pagination honours the page size and the before cursor', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const person = f.employee('image_pagination');
    for (let index = 0; index < 5; index += 1) assert.equal((await submit(f, person, { prompt: '素材 ' + index })).status, 202);
    await eventually(() => f.images.health().pending === 0, 8000);
    const first = await person.call('GET', '/api/images/jobs?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.jobs.length, 2);
    assert.equal(first.body.hasMore, true);
    const second = await person.call('GET', '/api/images/jobs?limit=2&before=' + first.body.jobs.at(-1).createdAt);
    assert.equal(second.body.jobs.length, 2);
    assert.equal(second.body.hasMore, true);
    const third = await person.call('GET', '/api/images/jobs?limit=2&before=' + second.body.jobs.at(-1).createdAt);
    assert.equal(third.body.jobs.length, 1);
    assert.equal(third.body.hasMore, false);
    const seen = new Set([...first.body.jobs, ...second.body.jobs, ...third.body.jobs].map(job => job.id));
    assert.equal(seen.size, 5);
    for (const query of ['limit=0', 'limit=99', 'limit=abc', 'before=-1', 'before=abc']) {
        const response = await person.call('GET', '/api/images/jobs?' + query);
        assert.equal(response.status, 400, query);
        assert.equal(response.body.error.code, 'INVALID_PAGINATION');
    }
});

test('the job view reports elapsed time and the download name uses the preset, not the prompt', async context => {
    const f = await fixture(context, { config: { ...configured, imageMinuteLimit: 60 }, fetchImpl: okTransport() });
    const person = f.employee('image_view');
    const created = await submit(f, person, { prompt: '门店门头招牌', size: '16:9' });
    assert.equal(created.body.job.state, 'queued');
    assert.equal(created.body.job.image, null);
    assert.equal(created.body.job.error, null);
    assert.equal(created.body.job.sizeKey, '16:9');
    const job = await finished(f, person, created.body.job.id);
    assert.ok(job.elapsedMs >= 0);
    assert.deepEqual(Object.keys(job).sort(), ['createdAt', 'elapsedMs', 'error', 'id', 'image', 'prompt', 'sizeKey', 'state', 'updatedAt']);
    assert.deepEqual(Object.keys(job.image).sort(), ['bytes', 'fileName', 'height', 'mime', 'url', 'width']);
    assert.equal(downloadName({ size_key: '16:9', created_at: Date.UTC(2026, 9, 31, 7, 30), file_name: 'a.png' }).startsWith('素材-16比9-'), true);
    assert.equal(downloadName({ size_key: 'auto', created_at: Date.UTC(2026, 9, 31), file_name: 'x/a.webp' }).endsWith('.webp'), true);
});

// ---------------------------------------------------------------- frontend contract

test('the panel wiring matches the agreed constants and the sidebar entry exists', async () => {
    const panel = await import('../src/images.js');
    assert.equal(panel.POLL_MS, 2000, 'polling interval');
    assert.equal(panel.HISTORY_PAGE, 12, 'first history screen');
    assert.deepEqual(panel.TEMPLATES.map(template => template.label),
        ['产品平铺', '海报竖版', '贴片背景', '门店场景', '人物氛围']);
    for (const template of panel.TEMPLATES) assert.ok(template.prompt.length > 10, template.key);
    // Every backend error code has a frontend text, so a notice never falls back to raw output.
    for (const code of ['IMAGE_UPSTREAM_QUOTA', 'IMAGE_UPSTREAM_AUTH', 'IMAGE_CONTENT_BLOCKED', 'IMAGE_UPSTREAM_BUSY',
        'IMAGE_UPSTREAM_ERROR', 'IMAGE_RESULT_UNKNOWN', 'IMAGE_JOB_INTERRUPTED', 'IMAGE_JOB_CANCELLED',
        'IMAGE_RATE_LIMITED', 'IMAGE_QUEUE_FULL', 'IMAGE_NOT_CONFIGURED', 'INVALID_IMAGE_INPUT',
        'IMAGE_REQUEST_ID_CONFLICT', 'IMAGE_NOT_READY', 'IMAGE_FILE_MISSING', 'IMAGE_JOB_NOT_FOUND']) {
        assert.equal(typeof panel.ERROR_TEXT[code], 'string', 'missing text for ' + code);
    }
    assert.equal(panel.errorText('IMAGE_UPSTREAM_QUOTA'), '生图服务额度未开通，请联系管理员');
    assert.equal(panel.errorText('UNKNOWN_CODE', '后端文案'), '后端文案');
    assert.equal(panel.errorText('UNKNOWN_CODE'), '生成没有完成，请稍后重试。');

    const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    assert.match(app, /import \{ openImagesPanel \} from '\.\/images\.js';/);
    assert.match(app, /button\('素材生成', \(\) => openImages\(\), \{ className: 'nav-item', glyph: 'spark' \}\)/);
    assert.match(app, /function openImages\(\) \{\s*openImagesPanel\(\);/);

    // The stylesheet is bundled as one file, and images.css must come after the theme tokens.
    const style = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
    assert.deepEqual(style.trim().split('\n'), ["@import './base.css';", "@import './studio.css';",
        "@import './images.css';", "@import './control-panel.css';", "@import './grounding.css';"]);
    const css = fs.readFileSync(path.join(root, 'src/images.css'), 'utf8');
    assert.match(css, /\.image-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /min-height: 44px/, 'mobile touch targets');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.doesNotMatch(css.replace(/rgba\([^)]*\)/g, ''), /#[0-9a-fA-F]{3,8}\b/, 'no hard coded hex colours');
    // The service worker cache list is intentionally untouched (assets/style.css is a single bundle).
    assert.match(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), /assets\/style\.css/);
});
