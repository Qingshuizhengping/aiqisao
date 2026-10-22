import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createStudioJobStore, JOB_KEY_PREFIX, LEGACY_JOB_KEY, isJobRecord } from '../src/studio-job-store.js';
import { createStudioJobController } from '../src/studio-job-controller.js';

const recordFixture = (overrides = {}) => ({ id: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64),
    createdAt: Date.now(), accepted: true, prompt: '产品摄影', size: 'auto', referenceCount: 0, optimizationEnabled: true, ...overrides });
const snapshotFixture = (overrides = {}) => ({ prompt: '透明产品摄影', inputPrompt: '透明产品摄影', size: 'auto', referenceImages: [], optimizationEnabled: true, ...overrides });
const jobFixture = (record, state = 'queued', fields = {}) => ({ id: record.id, state, originalPrompt: record.prompt, size: record.size, referenceCount: record.referenceCount, ...fields });
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const good = job => response(200, { status: 'ok', job });
const tick = () => new Promise(resolve => setImmediate(resolve));

function memoryStorage(initial = []) {
    const values = new Map(initial);
    return {
        values,
        get length() { return values.size; },
        key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
}

function eventSurface() {
    const listeners = new Map();
    return {
        hidden: false,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        dispatch(type, fields = {}) { for (const listener of listeners.get(type) || []) listener({ type, ...fields }); }
    };
}

function setup({ storage = memoryStorage(), handler, now = Date.now, snapshots = new Map(), hidden = false, consume = true } = {}) {
    const store = createStudioJobStore(storage);
    const documentTarget = eventSurface();
    documentTarget.hidden = hidden;
    const windowTarget = eventSurface();
    const timers = new Map();
    const requests = [];
    let timerId = 0;
    const controller = createStudioJobController({ store, getSnapshot: id => snapshots.get(id), cryptoImpl: webcrypto,
        documentTarget, windowTarget, now,
        setTimer: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimer: identifier => timers.delete(identifier),
        fetchImpl: async (url, options) => {
            requests.push({ url, ...options });
            if (handler) return handler(url, options, store);
            const id = options.method === 'POST' ? JSON.parse(options.body).requestId : url.split('/').at(-1);
            return good(jobFixture(store.read(id)));
        }
    });
    const states = [];
    controller.subscribe(state => states.push(state));
    if (consume) controller.subscribe(state => {
        if (state.outcome) controller.acknowledge(state.outcome.sequence);
    });
    return { storage, store, controller, snapshots, documentTarget, windowTarget, timers, requests, states,
        async submit(snapshot = snapshotFixture()) {
            const record = controller.create(snapshot);
            snapshots.set(record.id, snapshot);
            await controller.upload(record.id);
            return record;
        }
    };
}

test('job storage isolates capabilities by id and deleting A never deletes B', () => {
    const store = createStudioJobStore(memoryStorage());
    const first = recordFixture();
    const second = recordFixture({ id: '22222222-2222-4222-8222-222222222222', token: 'b'.repeat(64) });
    store.create(first);
    store.create(second);
    store.remove(first);
    assert.deepEqual(store.list(), [second]);
    store.remove({ ...second, token: 'c'.repeat(64) });
    assert.deepEqual(store.read(second.id), second);
});

test('accepted capability updates are monotonic and late acknowledgement cannot resurrect a deleted task', () => {
    const store = createStudioJobStore(memoryStorage());
    const record = recordFixture({ accepted: false });
    store.create(record);
    store.accept(record);
    store.create(record);
    assert.equal(store.read(record.id).accepted, true);
    store.remove(record);
    store.accept(record);
    assert.equal(store.read(record.id), null);
});

test('legacy migration writes an independent capability before removing the old key', () => {
    const record = recordFixture();
    const storage = memoryStorage([[LEGACY_JOB_KEY, JSON.stringify(record)]]);
    const store = createStudioJobStore(storage);
    assert.deepEqual(store.list(), [record]);
    assert.equal(storage.getItem(LEGACY_JOB_KEY), null);
    assert.deepEqual(store.read(record.id), record);
});

test('failed legacy migration preserves a readable original credential and never loses it', () => {
    const record = recordFixture();
    const storage = memoryStorage([[LEGACY_JOB_KEY, JSON.stringify(record)]]);
    storage.setItem = () => { throw new Error('quota'); };
    const store = createStudioJobStore(storage);
    assert.deepEqual(store.list(), [record]);
    assert.notEqual(storage.getItem(LEGACY_JOB_KEY), null);
});

test('legacy unconfirmed migration does not downgrade an already acknowledged per-job record', () => {
    const record = recordFixture();
    const storage = memoryStorage([[LEGACY_JOB_KEY, JSON.stringify({ ...record, accepted: false })], [JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]);
    assert.equal(createStudioJobStore(storage).list()[0].accepted, true);
});

test('invalid and mismatched capability records are ignored', () => {
    const record = recordFixture();
    const storage = memoryStorage([[LEGACY_JOB_KEY, JSON.stringify({ ...record, token: 'bad' })], [JOB_KEY_PREFIX + 'wrong-id', JSON.stringify(record)]]);
    assert.deepEqual(createStudioJobStore(storage).list(), []);
    assert.equal(storage.getItem(LEGACY_JOB_KEY), null);
    assert.equal(isJobRecord({ ...record, referenceCount: 21 }), false);
});

test('creation persists before POST and sends ordered multiple references with auto sizing', async () => {
    const fixture = setup({ handler: async (url, options, store) => {
        const id = options.method === 'POST' ? JSON.parse(options.body).requestId : url.split('/').at(-1);
        const record = store.read(id);
        assert.ok(record);
        assert.equal(options.headers.Authorization, 'Bearer ' + record.token);
        assert.equal(url.includes(record.token), false);
        return good(jobFixture(record));
    } });
    const references = Array.from({ length: 20 }, (_, index) => 'data:image/png;base64,' + index);
    await fixture.submit(snapshotFixture({ referenceImages: references }));
    const payload = JSON.parse(fixture.requests[0].body);
    assert.deepEqual(payload.referenceImages, references);
    assert.equal(payload.size, 'auto');
    assert.equal(payload.optimize, true);
    assert.equal(fixture.controller.getState().record.accepted, true);
    assert.equal([...fixture.storage.values.values()].some(value => value.includes('data:image')), false);
    fixture.controller.dispose();
});

test('storage failure prevents every generation request', () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('quota'); };
    const fixture = setup({ storage });
    assert.throws(() => fixture.controller.create(snapshotFixture()), /尚未提交生成/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.controller.getState().record, null);
});

test('reload only queries existing task and exposes successful result without resubmitting', async () => {
    const record = recordFixture({ referenceCount: 20 });
    const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/restored.png' } })) });
    fixture.controller.start();
    await tick();
    assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
    assert.equal(fixture.controller.getState().outcome.job.result.url, '/static/gen/restored.png');
    assert.equal(fixture.controller.getState().outcome.record.referenceCount, 20);
    assert.equal(fixture.store.read(record.id), null);
    fixture.controller.dispose();
});

test('lost POST acknowledgement is recovered by GET without another POST', async () => {
    const fixture = setup({ handler: async (url, options, store) => {
        if (options.method === 'POST') throw new TypeError('connection closed');
        return good(jobFixture(store.read(url.split('/').at(-1)), 'generating'));
    } });
    await fixture.submit();
    assert.deepEqual(fixture.requests.map(request => request.method), ['POST', 'GET']);
    assert.equal(fixture.controller.getState().record.accepted, true);
    assert.equal(fixture.controller.getState().business, 'generating');
    fixture.controller.dispose();
});

test('unconfirmed upload requires explicit retry and reuses identical id token and payload', async () => {
    let uploads = 0;
    const fixture = setup({ handler: async (url, options, store) => {
        if (options.method === 'POST' && ++uploads === 1) throw new TypeError('connection closed');
        if (uploads === 1) return response(404, { status: 'error' });
        return good(jobFixture(store.list()[0]));
    } });
    await fixture.submit();
    assert.equal(fixture.controller.getState().issue.code, 'UPLOAD_REQUIRED');
    assert.equal(fixture.timers.size, 0);
    fixture.windowTarget.dispatch('online');
    await tick();
    assert.equal(uploads, 1);
    await fixture.controller.retry();
    const posts = fixture.requests.filter(request => request.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body, posts[1].body);
    assert.equal(posts[0].headers.Authorization, posts[1].headers.Authorization);
    fixture.controller.dispose();
});

test('expired tasks remain explicitly uncertain even when original acknowledgement was lost', async () => {
    for (const accepted of [true, false]) {
        const record = recordFixture({ accepted, createdAt: Date.now() - 26 * 3600000 });
        const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => response(404, { status: 'error' }) });
        fixture.controller.start();
        await tick();
        assert.equal(fixture.controller.getState().outcome.uncertain, true);
        assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
        fixture.controller.dispose();
    }
});

test('a stale upload is never POSTed again with an old capability', async () => {
    let clock = Date.now();
    const fixture = setup({ now: () => clock, handler: async () => response(404, { status: 'error' }) });
    const record = fixture.controller.create(snapshotFixture());
    fixture.snapshots.set(record.id, snapshotFixture());
    clock += 600001;
    await fixture.controller.upload(record.id);
    assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
    assert.equal(fixture.controller.getState().outcome.uncertain, true);
});

test('hidden documents stop polling and resume immediately on visibility without new POST', async () => {
    const record = recordFixture();
    const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), hidden: true });
    fixture.controller.start();
    assert.equal(fixture.requests.length, 0);
    fixture.documentTarget.hidden = false;
    fixture.documentTarget.dispatch('visibilitychange');
    await tick();
    assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
    assert.equal(fixture.timers.size, 1);
    fixture.documentTarget.hidden = true;
    fixture.documentTarget.dispatch('visibilitychange');
    assert.equal(fixture.timers.size, 0);
    fixture.controller.dispose();
});

test('pageshow online and visibility wakeups share a single in-flight poll', async () => {
    const record = recordFixture();
    let release;
    const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: () => new Promise(resolve => { release = () => resolve(good(jobFixture(record))); }) });
    fixture.controller.start();
    fixture.windowTarget.dispatch('pageshow');
    fixture.windowTarget.dispatch('online');
    fixture.documentTarget.dispatch('visibilitychange');
    assert.equal(fixture.requests.length, 1);
    release();
    await tick();
    fixture.windowTarget.dispatch('pagehide');
    assert.equal(fixture.timers.size, 0);
    fixture.controller.dispose();
});

test('disposing during a request preserves the credential for the next page', async () => {
    const record = recordFixture();
    let release;
    const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: () => new Promise(resolve => { release = () => resolve(good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/late.png' } }))); }) });
    fixture.controller.start();
    fixture.controller.dispose();
    release();
    await tick();
    assert.notEqual(fixture.store.read(record.id), null);
    assert.equal(fixture.controller.getState().outcome, null);
    assert.equal(fixture.timers.size, 0);
});

test('multiple restored jobs remain selectable after each completion', async () => {
    const first = recordFixture({ createdAt: 100 });
    const second = recordFixture({ id: '22222222-2222-4222-8222-222222222222', createdAt: 200 });
    const fixture = setup({ storage: memoryStorage([first, second].map(record => [JOB_KEY_PREFIX + record.id, JSON.stringify(record)])), handler: async (url, options, store) => good(jobFixture(store.read(url.split('/').at(-1)), 'succeeded', { result: { url: '/static/gen/' + url.split('/').at(-1) + '.png' } })) });
    fixture.controller.start();
    await tick();
    assert.equal(fixture.controller.getState().outcome.record.id, first.id);
    assert.deepEqual(fixture.controller.getState().pending.map(record => record.id), [second.id]);
    fixture.controller.activate(second.id);
    await tick();
    assert.equal(fixture.controller.getState().outcome.record.id, second.id);
    assert.equal(fixture.controller.getState().pending.length, 0);
    assert.deepEqual(fixture.requests.map(request => request.method), ['GET', 'GET']);
    fixture.controller.dispose();
});

test('storage events discover another tab task and never submit it again', async () => {
    const fixture = setup();
    fixture.controller.start();
    const record = recordFixture();
    fixture.store.create(record);
    fixture.windowTarget.dispatch('storage', { key: JOB_KEY_PREFIX + record.id });
    await tick();
    assert.equal(fixture.controller.getState().record.id, record.id);
    assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
    fixture.controller.dispose();
});

test('late completion from an old tab cannot delete a newer task recovery credential', async () => {
    const storage = memoryStorage();
    const record = recordFixture();
    createStudioJobStore(storage).create(record);
    const serverJobs = new Map([[record.id, jobFixture(record)]]);
    const handler = async (url, options, store) => {
        if (options.method === 'POST') {
            const id = JSON.parse(options.body).requestId;
            serverJobs.set(id, jobFixture(store.read(id), 'generating'));
        }
        const id = options.method === 'POST' ? JSON.parse(options.body).requestId : url.split('/').at(-1);
        return good(serverJobs.get(id));
    };
    const first = setup({ storage, handler });
    const stale = setup({ storage, handler });
    first.controller.start();
    stale.controller.start();
    await tick();
    stale.documentTarget.hidden = true;
    stale.documentTarget.dispatch('visibilitychange');
    serverJobs.set(record.id, jobFixture(record, 'succeeded', { result: { url: '/static/gen/first.png' } }));
    await first.controller.poll();
    const newer = await first.submit(snapshotFixture({ prompt: 'newer task' }));
    stale.documentTarget.hidden = false;
    stale.documentTarget.dispatch('visibilitychange');
    await tick();
    assert.equal(stale.controller.getState().outcome.record.id, record.id);
    assert.notEqual(first.store.read(newer.id), null);
    const reloaded = setup({ storage, handler });
    reloaded.controller.start();
    await tick();
    assert.equal(reloaded.controller.getState().record.id, newer.id);
    assert.deepEqual(reloaded.requests.map(request => request.method), ['GET']);
    first.controller.dispose();
    stale.controller.dispose();
    reloaded.controller.dispose();
});

test('mismatched server metadata preserves credential and exposes connection failure instead of an unrelated result', async () => {
    const record = recordFixture();
    const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => good(jobFixture(record, 'succeeded', { originalPrompt: 'unrelated', result: { url: '/wrong.png' } })) });
    fixture.controller.start();
    await tick();
    assert.equal(fixture.controller.getState().network, 'offline');
    assert.equal(fixture.controller.getState().outcome, null);
    assert.notEqual(fixture.store.read(record.id), null);
    fixture.controller.dispose();
});

test('terminal business states preserve clarification and uncertainty without new generation', async () => {
    for (const [state, fields, uncertain] of [
        ['needs_clarification', { question: '请说明主体' }, false],
        ['failed', { code: 'OPTIMIZATION_UNAVAILABLE', allowOriginal: true }, false],
        ['failed', { code: 'IMAGE_GENERATION_UNKNOWN' }, true],
        ['interrupted', {}, true]
    ]) {
        const record = recordFixture({ referenceCount: 2 });
        const fixture = setup({ storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => good(jobFixture(record, state, fields)) });
        fixture.controller.start();
        await tick();
        assert.equal(fixture.controller.getState().outcome.job.state, state);
        assert.equal(fixture.controller.getState().outcome.uncertain, uncertain);
        assert.equal(fixture.controller.getState().outcome.record.referenceCount, 2);
        assert.deepEqual(fixture.requests.map(request => request.method), ['GET']);
        fixture.controller.dispose();
    }
});

test('switching tasks while a poll is in flight keeps both eventual results selectable', async () => {
    const first = recordFixture({ createdAt: 100 });
    const second = recordFixture({ id: '22222222-2222-4222-8222-222222222222', createdAt: 200 });
    let release;
    const fixture = setup({ storage: memoryStorage([first, second].map(record => [JOB_KEY_PREFIX + record.id, JSON.stringify(record)])), handler: async url => {
        if (url.endsWith(first.id)) return new Promise(resolve => { release = () => resolve(good(jobFixture(first, 'succeeded', { result: { url: '/static/gen/first.png' } }))); });
        return good(jobFixture(second, 'succeeded', { result: { url: '/static/gen/second.png' } }));
    } });
    fixture.controller.start();
    fixture.controller.activate(second.id);
    await tick();
    assert.equal(fixture.controller.getState().outcome.record.id, second.id);
    release();
    await tick();
    assert.equal(fixture.controller.getState().outcome.record.id, second.id);
    assert.deepEqual(fixture.controller.getState().pending.map(record => record.id), [first.id]);
    assert.notEqual(fixture.store.read(first.id), null);
    fixture.controller.activate(first.id);
    assert.equal(fixture.controller.getState().outcome.record.id, first.id);
    assert.equal(fixture.requests.length, 2);
    fixture.controller.dispose();
});

test('nonactive upload rejection remains recoverable without replacing another task result', async () => {
    const second = recordFixture({ id: '22222222-2222-4222-8222-222222222222' });
    let rejectUpload;
    const fixture = setup({ handler: async (url, options) => {
        if (options.method === 'POST') return new Promise(resolve => { rejectUpload = () => resolve(response(429, { status: 'error', error: '限流' })); });
        return good(jobFixture(second, 'succeeded', { result: { url: '/static/gen/second.png' } }));
    } });
    fixture.controller.start();
    const first = fixture.controller.create(snapshotFixture());
    fixture.snapshots.set(first.id, snapshotFixture());
    const pendingUpload = fixture.controller.upload(first.id);
    fixture.store.create(second);
    fixture.windowTarget.dispatch('storage', { key: JOB_KEY_PREFIX + second.id });
    fixture.controller.activate(second.id);
    await tick();
    rejectUpload();
    await pendingUpload;
    assert.equal(fixture.controller.getState().outcome.record.id, second.id);
    assert.notEqual(fixture.store.read(first.id), null);
    fixture.controller.activate(first.id);
    assert.equal(fixture.controller.getState().outcome.record.id, first.id);
    assert.equal(fixture.controller.getState().outcome.job.state, 'rejected');
    assert.equal(fixture.controller.getState().outcome.uncertain, false);
    fixture.controller.dispose();
});

test('acknowledgement from another tab clears upload retry and resumes GET instead of POST', async () => {
    let acknowledged = false;
    const fixture = setup({ handler: async (url, options, store) => {
        if (options.method === 'POST') throw new TypeError('lost acknowledgement');
        if (!acknowledged) return response(404, { status: 'error' });
        return good(jobFixture(store.read(url.split('/').at(-1)), 'generating'));
    } });
    fixture.controller.start();
    const record = await fixture.submit();
    assert.equal(fixture.controller.getState().issue.code, 'UPLOAD_REQUIRED');
    acknowledged = true;
    fixture.store.accept(record);
    fixture.windowTarget.dispatch('storage', { key: JOB_KEY_PREFIX + record.id });
    await tick();
    assert.equal(fixture.controller.getState().issue, null);
    assert.equal(fixture.controller.getState().business, 'generating');
    assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1);
    fixture.controller.dispose();
});

test('unconsumed terminal results retain their capability and remain selectable until explicitly acknowledged', async () => {
    const record = recordFixture();
    const fixture = setup({ consume: false, storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/unconsumed.png' } })) });
    fixture.controller.start();
    await tick();
    const outcome = fixture.controller.getState().outcome;
    assert.equal(outcome.job.state, 'succeeded');
    assert.notEqual(fixture.store.read(record.id), null);
    assert.deepEqual(fixture.controller.getState().pending.map(item => item.id), [record.id]);
    assert.equal(fixture.controller.acknowledge(outcome.sequence + 1), false);
    assert.notEqual(fixture.store.read(record.id), null);
    assert.equal(fixture.controller.acknowledge(outcome.sequence), true);
    assert.equal(fixture.store.read(record.id), null);
    assert.equal(fixture.controller.getState().pending.length, 0);
    fixture.controller.dispose();
});

test('history storage failure can leave a result unacknowledged and reload recovers by GET without another POST', async () => {
    const record = recordFixture();
    const storage = memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]);
    const handler = async () => good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/recoverable.png' } }));
    const first = setup({ storage, handler, consume: false });
    first.controller.start();
    await tick();
    first.controller.dispose();
    const reloaded = setup({ storage, handler });
    reloaded.controller.start();
    await tick();
    assert.equal(reloaded.controller.getState().outcome.job.result.url, '/static/gen/recoverable.png');
    assert.deepEqual(first.requests.concat(reloaded.requests).map(request => request.method), ['GET', 'GET']);
    assert.equal(reloaded.store.read(record.id), null);
    reloaded.controller.dispose();
});

test('late consumer acknowledgement only removes its own job, not a newer active task', async () => {
    const record = recordFixture();
    const fixture = setup({ consume: false, storage: memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]), handler: async () => good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/old.png' } })) });
    fixture.controller.start();
    await tick();
    const outcome = fixture.controller.getState().outcome;
    const newer = fixture.controller.create(snapshotFixture());
    assert.equal(fixture.controller.acknowledge(outcome.sequence), true);
    assert.notEqual(fixture.store.read(newer.id), null);
    assert.equal(fixture.controller.getState().record.id, newer.id);
    fixture.controller.dispose();
});

test('failed acknowledgement keeps the terminal task available for later recovery', async () => {
    const record = recordFixture();
    const storage = memoryStorage([[JOB_KEY_PREFIX + record.id, JSON.stringify(record)]]);
    const fixture = setup({ storage, consume: false, handler: async () => good(jobFixture(record, 'succeeded', { result: { url: '/static/gen/saved.png' } })) });
    fixture.controller.start();
    await tick();
    storage.removeItem = () => { throw new Error('storage disabled'); };
    assert.equal(fixture.controller.acknowledge(fixture.controller.getState().outcome.sequence), false);
    assert.notEqual(fixture.store.read(record.id), null);
    assert.equal(fixture.controller.getState().pending.length, 1);
    fixture.controller.dispose();
});
