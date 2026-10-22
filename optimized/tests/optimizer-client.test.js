import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createOptimizerClient, OptimizerClientError } from '../api/optimizer_client.js';
import { createImagePromptService } from '../api/image_prompt.js';

globalThis.fetch = async () => { throw new Error('Real model requests are forbidden in optimizer client tests'); };

function configuration(overrides = {}) {
    return { PROMPT_OPTIMIZER_ENABLED: 'true', PROMPT_OPTIMIZER_API_BASE: 'https://fixture.invalid/v1',
        PROMPT_OPTIMIZER_API_KEY: 'fixture-key', PROMPT_OPTIMIZER_MODEL: 'fixture-model', ...overrides };
}

function input(overrides = {}) {
    return { prompt: '玻璃杯产品图，保留准确文案', size: 'auto', referenceCount: 2, ...overrides };
}

function preparation(overrides = {}) {
    return { prompt: '玻璃杯产品图', size: 'auto', referenceHashes: [], requestId: randomUUID(), ...overrides };
}

function response(decision = { decision: 'ready', optimizedPrompt: '柔和侧光，背景留白，主体层次清晰。', intent: '产品视觉' }) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }));
}

function ready(payload) {
    return { status: 'ready', originalPrompt: payload.prompt, optimizedPrompt: payload.prompt + '，柔和侧光', intent: '产品视觉' };
}

test('client reads configuration dynamically and exposes only readiness', async () => {
    const env = configuration({ PROMPT_OPTIMIZER_ENABLED: '', PROMPT_OPTIMIZER_API_KEY: '' });
    let chatKey = 'fallback-one';
    const requests = [];
    const client = createOptimizerClient({ env, getChatApiKey: () => chatKey, async fetchImpl(url, options) {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return response();
    } });
    assert.deepEqual(client.health(), { ready: false });
    await assert.rejects(() => client.optimize(input()), { kind: 'unavailable', status: 503 });
    assert.equal(requests.length, 0);
    env.PROMPT_OPTIMIZER_ENABLED = 'true';
    assert.deepEqual(client.health(), { ready: true });
    const result = await client.optimize(input({ referenceImages: ['private-reference'], referenceHashes: ['private-hash'] }));
    assert.equal(result.status, 'ready');
    assert.equal(result.originalPrompt, input().prompt);
    assert.equal(result.optimizedPrompt.startsWith(input().prompt), true);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer fallback-one');
    assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), {
        originalPrompt: input().prompt, size: 'auto', referenceCount: 2,
    });
    assert.equal(JSON.stringify(requests[0]).includes('private-reference'), false);
    assert.equal(requests[0].options.redirect, 'manual');
    assert.equal(requests[0].options.signal.aborted, true);
    chatKey = 'fallback-two';
    env.PROMPT_OPTIMIZER_MODEL = 'replacement-model';
    env.PROMPT_OPTIMIZER_API_BASE = 'https://other-fixture.invalid/v2/';
    await client.optimize(input());
    assert.equal(requests[1].url, 'https://other-fixture.invalid/v2/chat/completions');
    assert.equal(requests[1].body.model, 'replacement-model');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer fallback-two');
    env.PROMPT_OPTIMIZER_API_KEY = 'explicit-key';
    await client.optimize(input());
    assert.equal(requests[2].options.headers.Authorization, 'Bearer explicit-key');
    env.PROMPT_OPTIMIZER_API_BASE = 'http://invalid.fixture/v1';
    assert.deepEqual(client.health(), { ready: false });
    await assert.rejects(() => client.optimize(input()), { kind: 'unavailable', status: 503 });
    assert.equal(requests.length, 3);
});

test('submission hook is synchronous, precedes HTTP, and can deny without a provider attempt', async () => {
    const events = [];
    const timer = {};
    const client = createOptimizerClient({ env: configuration({ PROMPT_OPTIMIZER_TIMEOUT_MS: '20000' }),
        setTimer(callback, duration) { events.push(['timer', duration]); return timer; },
        clearTimer(value) { assert.equal(value, timer); events.push('clear'); },
        async fetchImpl() { events.push('fetch'); return response(); } });
    const denial = new Error('local permit denied');
    await assert.rejects(() => client.optimize(input(), { beforeSubmit() { events.push('permit'); throw denial; } }), error => error === denial);
    assert.deepEqual(events, [['timer', 20000], 'permit', 'clear']);
    events.length = 0;
    await client.optimize(input(), { beforeSubmit() { events.push('permit'); } });
    assert.deepEqual(events, [['timer', 20000], 'permit', 'fetch', 'clear']);
});

test('client normalizes clarification and safety without exposing provider text or retrying', async () => {
    const clarify = createOptimizerClient({ env: configuration(), fetchImpl: async () => response({ decision: 'clarify', question: ' 海报还是产品图？ ' }) });
    assert.deepEqual(await clarify.optimize(input()), { status: 'needs_clarification', question: '海报还是产品图？' });
    for (const provider of [
        () => new Response('secret-provider-key', { status: 422 }),
        () => response({ decision: 'blocked' }),
        () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'secret-provider-key' } }] })),
    ]) {
        let calls = 0;
        const client = createOptimizerClient({ env: configuration(), async fetchImpl() { calls++; return provider(); } });
        await assert.rejects(() => client.optimize(input()), error => error instanceof OptimizerClientError
            && error.kind === 'blocked' && error.status === 422 && !error.message.includes('secret-provider-key'));
        assert.equal(calls, 1);
    }
    for (const provider of [
        () => new Response('secret-provider-key'),
        () => response({ decision: 'ready', optimizedPrompt: '新增￥99价格，承诺立即见效。', intent: '产品视觉' }),
        () => { throw Object.assign(new Error('secret-provider-key'), { status: 422, code: 'OPTIMIZATION_BLOCKED' }); },
    ]) {
        let calls = 0;
        const client = createOptimizerClient({ env: configuration(), async fetchImpl() { calls++; return provider(); } });
        await assert.rejects(() => client.optimize(input()), error => error instanceof OptimizerClientError
            && error.kind === 'unavailable' && error.status === 502 && !error.message.includes('secret-provider-key'));
        assert.equal(calls, 1);
    }
});

test('client response limits apply to declared and streamed bodies', async () => {
    for (const declared of [true, false]) {
        let cancelled = false;
        const client = createOptimizerClient({ env: configuration(), fetchImpl: async () => new Response(new ReadableStream({
            start(controller) { if (!declared) controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
            cancel() { cancelled = true; },
        }), declared ? { headers: { 'content-length': String(128 * 1024 + 1) } } : undefined) });
        await assert.rejects(() => client.optimize(input()), { kind: 'unavailable', status: 502 });
        assert.equal(cancelled, true);
    }
});

test('client has no default deadline and explicit timeouts include response streaming', async () => {
    const noDeadline = createOptimizerClient({ env: configuration(), fetchImpl: async () => response(),
        setTimer() { assert.fail('Default optimizer deadline must remain disabled'); } });
    await noDeadline.optimize(input());
    let expire;
    let cancelled = false;
    let cleared = false;
    const client = createOptimizerClient({ env: configuration({ PROMPT_OPTIMIZER_TIMEOUT_MS: '999999' }),
        setTimer(callback, duration) { assert.equal(duration, 900000); expire = callback; return 'timer'; },
        clearTimer(timer) { assert.equal(timer, 'timer'); cleared = true; },
        fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
            cancel() { cancelled = true; } })) });
    const operation = client.optimize(input());
    const rejected = assert.rejects(operation, { kind: 'unavailable', status: 504 });
    await nextTurn();
    expire();
    await rejected;
    assert.equal(cancelled, true);
    assert.equal(cleared, true);
});

test('client abort cancels response consumption and pre-abort does not consume a permit', async () => {
    let calls = 0;
    let permits = 0;
    let bodyCancelled = false;
    const client = createOptimizerClient({ env: configuration(), async fetchImpl() {
        calls++;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
            cancel() { bodyCancelled = true; } }));
    } });
    const controller = new AbortController();
    const operation = client.optimize(input(), { signal: controller.signal, beforeSubmit() { permits++; } });
    const rejected = assert.rejects(operation, { kind: 'cancelled', status: 499 });
    await nextTurn();
    controller.abort();
    await rejected;
    assert.equal(bodyCancelled, true);
    await assert.rejects(() => client.optimize(input(), { signal: controller.signal, beforeSubmit() { permits++; } }), { kind: 'cancelled', status: 499 });
    assert.equal(permits, 1);
    assert.equal(calls, 1);
});

test('injected client leaves metadata, signing, generation and idempotency in the prompt service', async () => {
    let calls = 0;
    let images = 0;
    let expected;
    const service = createImagePromptService({ env: {}, optimizerClient: {
        health: () => ({ ready: true }), async optimize(payload, options) {
            calls++;
            assert.deepEqual(payload, { prompt: expected.prompt, size: expected.size, referenceCount: 1 });
            options.beforeSubmit();
            return ready(payload);
        },
    }, async generate(payload, key, options) {
        options.beforeSubmit();
        images++;
        assert.equal(payload.prompt, expected.prompt + '，柔和侧光');
        return { url: '/static/gen/injected.png' };
    } });
    const reference = 'data:image/jpeg;base64,/9j/AA==';
    expected = preparation({ referenceHashes: [createHash('sha256').update(reference).digest('hex')] });
    assert.deepEqual(service.getPromptOptimizationHealth(), { promptOptimizationReady: true, promptOptimizationMode: 'text' });
    const prepared = await service.prepareImagePrompt(expected, 'owner');
    assert.equal(prepared.status, 'ready');
    assert.equal(typeof prepared.optimizationToken, 'string');
    assert.deepEqual(await service.prepareImagePrompt(expected, 'owner'), prepared);
    const payload = { prompt: expected.prompt, size: expected.size, requestId: expected.requestId,
        referenceImages: [reference], optimizationToken: prepared.optimizationToken };
    const generated = await service.generateImageRequest(payload, 'owner', 'fixture-key');
    assert.equal(generated.optimization.status, 'applied');
    assert.deepEqual(await service.generateImageRequest(payload, 'owner', 'fixture-key'), generated);
    assert.equal(calls, 1);
    assert.equal(images, 1);
});

test('submission boundary retains attempted optimizer errors but not pre-submit failures', async () => {
    for (const submitted of [false, true]) {
        let calls = 0;
        const service = createImagePromptService({ optimizerClient: { health: () => ({ ready: true }), async optimize(payload, options) {
            calls++;
            if (submitted) options.beforeSubmit();
            throw new OptimizerClientError('unavailable', 502);
        } } });
        const payload = preparation();
        for (let index = 0; index < 2; index++) {
            await assert.rejects(() => service.prepareImagePrompt(payload, 'owner'), { code: 'OPTIMIZATION_UNAVAILABLE', allowOriginal: true });
        }
        assert.equal(calls, submitted ? 1 : 2);
    }
});

test('prompt service still controls global budget with an injected client', async () => {
    let clock = 1000;
    let attempts = 0;
    let submissions = 0;
    const service = createImagePromptService({ now: () => clock, optimizerClient: {
        health: () => ({ ready: true }), async optimize(payload, options) {
            attempts++;
            options.beforeSubmit();
            submissions++;
            return ready(payload);
        },
    } });
    for (let index = 0; index < 120; index++) await service.prepareImagePrompt(preparation(), 'owner-' + index);
    const denied = preparation();
    await assert.rejects(() => service.prepareImagePrompt(denied, 'over-budget'), { code: 'OPTIMIZATION_UNAVAILABLE', status: 503 });
    assert.equal(attempts, 121);
    assert.equal(submissions, 120);
    clock += 3600000;
    assert.equal((await service.prepareImagePrompt(denied, 'over-budget')).status, 'ready');
    assert.equal(submissions, 121);
});

test('prompt service owns optimizer concurrency independently of the injected transport', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const service = createImagePromptService({ optimizerClient: {
        health: () => ({ ready: true }), async optimize(payload, options) {
            options.beforeSubmit();
            calls++;
            await gate;
            return ready(payload);
        },
    } });
    const first = service.prepareImagePrompt(preparation(), 'first');
    const second = service.prepareImagePrompt(preparation(), 'second');
    try {
        await nextTurn();
        await assert.rejects(() => service.prepareImagePrompt(preparation(), 'third'), { status: 503 });
        assert.equal(calls, 2);
    } finally {
        release();
        await Promise.all([first, second]);
    }
});
