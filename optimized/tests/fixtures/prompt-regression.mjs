import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { createImagePromptService } from '../../api/image_prompt.js';

const checks = [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfqoAAAAASUVORK5CYII=';
const jpg = 'data:image/jpeg;base64,/9j/AA==';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const readyDecision = { decision: 'ready', optimizedPrompt: '主体清晰，柔和侧光，背景简洁，保留产品材质细节。', intent: '产品宣传图片' };
const response = (decision = readyDecision) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }), { headers: { 'Content-Type': 'application/json' } });
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
    const optimizerRequests = [];
    const imageRequests = [];
    const timings = [];
    const clearedTimers = [];
    const clock = { value: 1000000 };
    const env = { PROMPT_OPTIMIZER_ENABLED: 'true', PROMPT_OPTIMIZER_API_BASE: 'https://fixture.invalid/v1',
        PROMPT_OPTIMIZER_MODEL: 'fixture-optimizer', PROMPT_OPTIMIZER_API_KEY: 'fixture-key', PROMPT_OPTIMIZER_SIGNING_KEY: 'fixture-signing-secret', ...overrides.env };
    const service = createImagePromptService({ env, now: () => clock.value, getChatApiKey: () => 'fixture-chat-key',
        setTimer: (callback, milliseconds) => { timings.push(milliseconds); return setTimeout(callback, overrides.fastTimeout ? 20 : milliseconds); },
        clearTimer: timer => { clearedTimers.push(timer); clearTimeout(timer); },
        async fetchImpl(url, options) {
            optimizerRequests.push({ url, options, body: JSON.parse(options.body) });
            return overrides.optimizer ? overrides.optimizer(url, options) : response();
        },
        async generate(payload, apiKey, options) {
            options.beforeSubmit();
            imageRequests.push({ payload, apiKey });
            return overrides.generator ? overrides.generator(payload) : { url: '/static/gen/fixture.png', revisedPrompt: 'provider fixture', tokens: 7 };
        } });
    return { ...service, optimizerRequests, imageRequests, clock, env, timings, clearedTimers };
}
const preparation = (overrides = {}) => ({ prompt: '一瓶香水的产品图', size: '1:1', referenceHashes: [], requestId: randomUUID(), ...overrides });
async function reject(task, status, code) {
    await assert.rejects(task, error => {
        assert.equal(error.status, status);
        if (code) assert.equal(error.code, code);
        return true;
    });
}
async function check(name, task) {
    try { await task(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.stack }); }
}
await check('disabled by default and HTTP optimizer bases fail closed without provider requests', async () => {
    for (const env of [{ PROMPT_OPTIMIZER_ENABLED: '' }, { PROMPT_OPTIMIZER_API_BASE: 'http://fixture.invalid/v1' }, { PROMPT_OPTIMIZER_API_BASE: 'https://user:password@fixture.invalid/v1' }]) {
        const service = fixture({ env });
        assert.deepEqual(service.getPromptOptimizationHealth(), { promptOptimizationReady: false, promptOptimizationMode: 'text' });
        await assert.rejects(() => service.prepareImagePrompt(preparation(), 'owner'), error => error.status === 503 && error.allowOriginal === true);
        assert.equal(service.optimizerRequests.length, 0);
    }
});
await check('chat credentials can be reused without persona; explicit overrides win', async () => {
    const service = fixture({ env: { PROMPT_OPTIMIZER_API_KEY: '' } });
    assert.equal(service.getPromptOptimizationHealth().promptOptimizationReady, true);
    await service.prepareImagePrompt(preparation(), 'owner');
    assert.equal(service.optimizerRequests[0].options.headers.Authorization, 'Bearer fixture-chat-key');
    assert.equal(service.optimizerRequests[0].body.model, 'fixture-optimizer');
    assert.equal(service.optimizerRequests[0].body.max_tokens, 600);
    assert.deepEqual(service.optimizerRequests[0].body.response_format, { type: 'json_object' });
    assert.equal(service.optimizerRequests[0].options.redirect, 'manual');
    assert.equal('reasoning_effort' in service.optimizerRequests[0].body, false);
    assert.equal(service.optimizerRequests[0].body.messages.length, 2);
    assert.equal(service.optimizerRequests[0].body.messages[0].content.includes('你是「AI七嫂」'), false);
});
await check('GLM optimizer override keeps visual direction concise without unsupported thinking fields', async () => {
    const service = fixture({ env: { PROMPT_OPTIMIZER_MODEL: 'zai-org/GLM-5.3-Flash', PROMPT_OPTIMIZER_TIMEOUT_MS: '20000' } });
    await service.prepareImagePrompt(preparation(), 'owner');
    const body = service.optimizerRequests[0].body;
    assert.equal(body.model, 'zai-org/GLM-5.3-Flash');
    assert.equal(body.max_tokens, 600);
    assert.equal(service.timings[0], 20000);
    for (const key of ['enable_thinking', 'thinking_budget', 'reasoning_effort']) assert.equal(key in body, false);
    const system = body.messages[0].content;
    for (const direction of ['视觉导演', '构图', '视觉层次', '色彩', '光照', '材质', '留白', '主体和准确文案必须保持不变', '没有收到参考图', '不虚构', '80–200字', '最多400字', '最多80字']) {
        assert.equal(system.includes(direction), true, direction);
    }
    assert.deepEqual(body.response_format, { type: 'json_object' });
});
for (const [name, changes] of [
    ['empty prompt', { prompt: '' }], ['nontext prompt', { prompt: {} }], ['oversized prompt', { prompt: '字'.repeat(4001) }],
    ['unknown size', { size: '4K' }], ['nonstr size', { size: {} }], ['non-array refs', { referenceHashes: {} }],
    ['over twenty refs', { referenceHashes: Array(21).fill(hash(png)) }], ['invalid hash', { referenceHashes: ['sk-secret'] }],
    ['uppercase hash', { referenceHashes: [hash(png).toUpperCase()] }], ['invalid UUID', { requestId: 'request' }],
    ['image bytes in metadata', { referenceImages: [png] }], ['unknown fields', { extra: true }],
]) {
    await check('prepare rejects ' + name + ' before optimizer or image provider', async () => {
        const service = fixture();
        await reject(() => service.prepareImagePrompt(preparation(changes), 'owner'), 400);
        assert.equal(service.optimizerRequests.length + service.imageRequests.length, 0);
    });
}
await check('ready preserves brands, quoted text, negatives and numbers verbatim; sees no reference image or hash', async () => {
    const service = fixture();
    const input = preparation({ prompt: '  品牌“薇之雨”，文案「今天不打折」，2瓶绿色产品，不要人像。  ', size: 'auto', referenceHashes: [hash(png), hash(jpg)] });
    const result = await service.prepareImagePrompt(input, 'owner');
    assert.equal(result.status, 'ready');
    assert.equal(result.originalPrompt, input.prompt.trim());
    assert.equal(result.optimizedPrompt.startsWith(input.prompt.trim()), true);
    assert.equal(result.intent, readyDecision.intent);
    assert.equal(result.expiresAt, service.clock.value + 300000);
    const sent = service.optimizerRequests[0].body.messages[1].content;
    assert.deepEqual(JSON.parse(sent), { originalPrompt: input.prompt.trim(), size: 'auto', referenceCount: 2 });
    assert.equal(sent.includes(hash(png)), false);
    assert.equal(sent.includes('data:image'), false);
    assert.equal(service.imageRequests.length, 0);
});
await check('prepare defaults to square and validates twenty ordered hashes', async () => {
    const service = fixture();
    const input = preparation({ size: undefined, referenceHashes: Array(20).fill(hash(png)) });
    await service.prepareImagePrompt(input, 'owner');
    assert.deepEqual(JSON.parse(service.optimizerRequests[0].body.messages[1].content), { originalPrompt: input.prompt, size: '1:1', referenceCount: 20 });
});
await check('identical pending and completed prepare requests charge only once', async () => {
    const gate = pending();
    const service = fixture({ optimizer: async () => { await gate.promise; return response(); } });
    const input = preparation();
    const first = service.prepareImagePrompt(input, 'owner');
    const second = service.prepareImagePrompt(input, 'owner');
    await delay(1);
    assert.equal(service.optimizerRequests.length, 1);
    gate.resolve();
    const values = await Promise.all([first, second]);
    assert.deepEqual(values[0], values[1]);
    assert.deepEqual(await service.prepareImagePrompt(input, 'owner'), values[0]);
    assert.equal(service.optimizerRequests.length, 1);
});
await check('same prepare ID with changed metadata conflicts; owner is independently scoped', async () => {
    const service = fixture();
    const input = preparation();
    await service.prepareImagePrompt(input, 'owner');
    for (const changes of [{ prompt: 'changed' }, { size: 'auto' }, { referenceHashes: [hash(png)] }]) {
        await reject(() => service.prepareImagePrompt({ ...input, ...changes }, 'owner'), 409, 'REQUEST_ID_CONFLICT');
    }
    await service.prepareImagePrompt(input, 'different-owner');
    assert.equal(service.optimizerRequests.length, 2);
});
await check('clarification is cached and cannot silently generate with the same request ID', async () => {
    const service = fixture({ optimizer: async () => response({ decision: 'clarify', question: '两张参考图分别参考什么？' }) });
    const input = preparation();
    assert.equal((await service.prepareImagePrompt(input, 'owner')).status, 'needs_clarification');
    await service.prepareImagePrompt(input, 'owner');
    await reject(() => service.generateImageRequest(input, 'owner', 'image-key'), 409, 'OPTIMIZATION_NOT_READY');
    assert.equal(service.optimizerRequests.length, 1);
    assert.equal(service.imageRequests.length, 0);
});
for (const [name, provider] of [
    ['model blocked', () => response({ decision: 'blocked' })],
    ['HTTP422', () => new Response('sk-provider-secret', { status: 422 })],
    ['message refusal', () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'sk-provider-secret' } }] }))],
    ['content_filter finish', () => new Response(JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '{}' } }] }))],
    ['safety code', () => new Response(JSON.stringify({ error: { code: 'content_filter', message: 'sk-provider-secret' } }))],
    ['safety message', () => new Response(JSON.stringify({ error: { code: '20022', message: '内容安全拦截 sk-provider-secret' } }))],
    ['plain-text model refusal', () => new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot assist with that request.' } }] }))],
]) {
    await check('safety refusal never allows original fallback: ' + name, async () => {
        const service = fixture({ optimizer: async () => provider() });
        const input = preparation();
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(() => service.prepareImagePrompt(input, 'owner'), error => error.status === 422 && !error.allowOriginal && !error.message.includes('sk-provider-secret'));
        }
        await reject(() => service.generateImageRequest(input, 'owner', 'image-key'), 422, 'OPTIMIZATION_BLOCKED');
        assert.equal(service.optimizerRequests.length, 1);
        assert.equal(service.imageRequests.length, 0);
    });
}
for (const [name, provider, status] of [
    ['malformed JSON', () => new Response('sk-provider-secret'), 502],
    ['wrong decision', () => response({ decision: 'unexpected' }), 502],
    ['extra JSON fields', () => response({ ...readyDecision, unexpected: 'sk-provider-secret' }), 502],
    ['missing fields', () => response({ decision: 'ready', optimizedPrompt: '光线清晰' }), 502],
    ['HTTP401', () => new Response(JSON.stringify({ error: { message: 'sk-provider-secret' } }), { status: 401 }), 503],
    ['HTTP429', () => new Response(JSON.stringify({ error: { message: 'sk-provider-secret' } }), { status: 429 }), 503],
    ['provider redirect', () => new Response('', { status: 307, headers: { location: 'https://attacker.invalid/' } }), 502],
    ['Content-Length overflow', () => new Response('{}', { headers: { 'content-length': String(128 * 1024 + 1) } }), 502],
    ['stream overflow', () => new Response('x'.repeat(128 * 1024 + 1)), 502],
]) {
    await check('technical errors are cached, sanitized and explicitly fall back: ' + name, async () => {
        const service = fixture({ optimizer: async () => provider() });
        const input = preparation();
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(() => service.prepareImagePrompt(input, 'owner'), error => error.status === status && error.code === 'OPTIMIZATION_UNAVAILABLE' && error.allowOriginal === true && !error.message.includes('sk-provider-secret'));
        }
        assert.equal(service.optimizerRequests.length, 1);
        assert.equal(service.imageRequests.length, 0);
    });
}
await check('untrusted thrown provider Error properties never leak provider body or key', async () => {
    const service = fixture({ optimizer: async () => { throw Object.assign(new Error('sk-provider-secret'), { code: 'NETWORK_ERROR', status: 502 }); } });
    await assert.rejects(() => service.prepareImagePrompt(preparation(), 'owner'), error => error.code === 'OPTIMIZATION_UNAVAILABLE' && !error.message.includes('sk-provider-secret'));
});
for (const text of ['醒目展示￥99，强调低价。', '画面增加8折优惠标识。', '加入祛斑美白功效承诺。', '用医学认证增强信任。']) {
    await check('new marketing claims cannot be invented: ' + text, async () => {
        const service = fixture({ optimizer: async () => response({ ...readyDecision, optimizedPrompt: text }) });
        await reject(() => service.prepareImagePrompt(preparation(), 'owner'), 502, 'OPTIMIZATION_UNAVAILABLE');
        assert.equal(service.imageRequests.length, 0);
    });
}
await check('existing explicit user price survives; total prompt over budget does not truncate constraints', async () => {
    const service = fixture({ optimizer: async () => response({ ...readyDecision, optimizedPrompt: '文案“￥99”保持原样，光线柔和。' }) });
    const result = await service.prepareImagePrompt(preparation({ prompt: '香水图，写￥99。' }), 'owner');
    assert.equal(result.optimizedPrompt.startsWith('香水图，写￥99。'), true);
    await reject(() => service.prepareImagePrompt(preparation({ prompt: '字'.repeat(3999) }), 'owner'), 502, 'OPTIMIZATION_UNAVAILABLE');
});
await check('optional positive timeout remains body-inclusive and caps administrator protection at fifteen minutes', async () => {
    const service = fixture({ env: { PROMPT_OPTIMIZER_TIMEOUT_MS: '999999' }, fastTimeout: true,
        optimizer: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    await reject(() => service.prepareImagePrompt(preparation(), 'owner'), 504, 'OPTIMIZATION_UNAVAILABLE');
    assert.equal(service.timings[0], 900000);
    assert.equal(service.clearedTimers.length, 1);
});
await check('optimizer default and explicit zero omit deadline timers while positive protection remains configurable', async () => {
    for (const [configured, expected] of [[undefined, null], ['0', null], ['20000', 20000], ['15000', 15000], ['999999', 900000], ['900000', 900000], ['1', 1000], ['invalid', null], ['-1', null]]) {
        const service = fixture({ env: { PROMPT_OPTIMIZER_TIMEOUT_MS: configured } });
        await service.prepareImagePrompt(preparation(), 'owner');
        assert.deepEqual(service.timings, expected === null ? [] : [expected], String(configured));
        assert.equal(service.clearedTimers.length, expected === null ? 0 : 1, String(configured));
        assert.equal(service.optimizerRequests.length, 1);
    }
});
await check('default and explicit zero wait beyond old twenty-second budget and sign only complete ready output once', async () => {
    for (const configured of [undefined, '0']) {
        const output = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(readyDecision) } }] });
        let controller;
        const service = fixture({ env: { PROMPT_OPTIMIZER_TIMEOUT_MS: configured }, optimizer: async () => new Response(new ReadableStream({
            start(stream) {
                controller = stream;
                stream.enqueue(new TextEncoder().encode(output.slice(0, 20)));
            },
        })) });
        let settled = false;
        const operation = service.prepareImagePrompt(preparation(), 'owner');
        operation.then(() => { settled = true; }, () => { settled = true; });
        await delay(1);
        service.clock.value += 25000;
        await delay(1);
        assert.equal(settled, false);
        assert.equal(service.optimizerRequests.length, 1);
        assert.equal(service.imageRequests.length, 0);
        assert.deepEqual(service.timings, []);
        assert.deepEqual(service.clearedTimers, []);
        controller.enqueue(new TextEncoder().encode(output.slice(20)));
        controller.close();
        const prepared = await operation;
        assert.equal(prepared.status, 'ready');
        assert.equal(typeof prepared.optimizationToken, 'string');
        assert.equal(prepared.expiresAt, service.clock.value + 300000);
        assert.equal(service.optimizerRequests.length, 1);
        assert.equal(service.imageRequests.length, 0);
        assert.deepEqual(service.timings, []);
        assert.deepEqual(service.clearedTimers, []);
    }
});
await check('visual suggestions enforce four-hundred-character cap without reducing existing intent hard limit', async () => {
    const accepted = fixture({ optimizer: async () => response({ ...readyDecision, optimizedPrompt: '画'.repeat(400), intent: '意'.repeat(200) }) });
    const prepared = await accepted.prepareImagePrompt(preparation(), 'owner');
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.intent.length, 200);
    for (const changes of [{ optimizedPrompt: '画'.repeat(401) }, { intent: '意'.repeat(201) }]) {
        const rejected = fixture({ optimizer: async () => response({ ...readyDecision, ...changes }) });
        await reject(() => rejected.prepareImagePrompt(preparation(), 'owner'), 502, 'OPTIMIZATION_UNAVAILABLE');
        assert.equal(rejected.imageRequests.length, 0);
    }
});
await check('client abort cancels optimizer body and prevents generation before any charge', async () => {
    const controller = new AbortController();
    const service = fixture({ optimizer: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    const input = preparation();
    const operation = service.prepareImagePrompt(input, 'owner', { signal: controller.signal });
    await delay(1);
    controller.abort();
    await reject(() => operation, 499, 'REQUEST_CANCELLED');
    await reject(() => service.generateImageRequest(input, 'owner', 'image-key', { signal: controller.signal }), 499, 'REQUEST_CANCELLED');
    assert.equal(service.optimizerRequests[0].options.signal.aborted, true);
    assert.equal(service.imageRequests.length, 0);
});
await check('optimizer concurrency is globally two; rejected third request never calls provider', async () => {
    const gate = pending();
    const service = fixture({ optimizer: async () => { await gate.promise; return response(); } });
    const first = service.prepareImagePrompt(preparation(), 'owner1');
    const second = service.prepareImagePrompt(preparation(), 'owner2');
    await delay(1);
    await reject(() => service.prepareImagePrompt(preparation(), 'owner3'), 503);
    assert.equal(service.optimizerRequests.length, 2);
    gate.resolve();
    await Promise.all([first, second]);
});
await check('optimizer per-IP five per minute and independent global hourly budget are enforced', async () => {
    const service = fixture();
    for (let attempt = 0; attempt < 5; attempt++) await service.prepareImagePrompt(preparation(), 'owner');
    await reject(() => service.prepareImagePrompt(preparation(), 'owner'), 429, 'OPTIMIZATION_RATE_LIMITED');
    for (let attempt = 0; attempt < 115; attempt++) await service.prepareImagePrompt(preparation(), 'owner-' + attempt);
    await reject(() => service.prepareImagePrompt(preparation(), 'over-budget'), 503, 'OPTIMIZATION_UNAVAILABLE');
    assert.equal(service.optimizerRequests.length, 120);
});
await check('free optimizer concurrency failures cannot evict pending entries or fill global cache', async () => {
    const gate = pending();
    const service = fixture({ optimizer: async () => { await gate.promise; return response(); } });
    const input = preparation();
    const first = service.prepareImagePrompt(input, 'first-owner');
    const second = service.prepareImagePrompt(preparation(), 'second-owner');
    await delay(1);
    for (let attempt = 0; attempt < 256; attempt++) await reject(() => service.prepareImagePrompt(preparation(), 'owner-' + attempt), 503);
    const replay = service.prepareImagePrompt(input, 'first-owner');
    gate.resolve();
    assert.deepEqual(await first, await replay);
    await second;
    assert.equal(service.optimizerRequests.length, 2);
    assert.equal((await service.prepareImagePrompt(preparation(), 'legitimate-owner')).status, 'ready');
    assert.equal(service.optimizerRequests.length, 3);
});
await check('256 free prepare IP-rate failures leave room for another owner and one generation', async () => {
    const service = fixture();
    for (let attempt = 0; attempt < 5; attempt++) await service.prepareImagePrompt(preparation(), 'limited-owner');
    for (let attempt = 0; attempt < 256; attempt++) {
        await reject(() => service.prepareImagePrompt(preparation(), 'limited-owner'), 429, 'OPTIMIZATION_RATE_LIMITED');
    }
    const input = preparation();
    const prepared = await service.prepareImagePrompt(input, 'legitimate-owner');
    assert.equal(prepared.status, 'ready');
    assert.equal(service.optimizerRequests.length, 6);
    await service.generateImageRequest({ prompt: input.prompt, requestId: input.requestId, optimizationToken: prepared.optimizationToken }, 'legitimate-owner', 'image-key');
    assert.equal(service.imageRequests.length, 1);
});
await check('optimized generation binds exact text, size, ordered trimmed dataURLs and one logical UUID', async () => {
    const service = fixture();
    const input = preparation({ size: 'auto', referenceHashes: [hash(png), hash(jpg)] });
    const prepared = await service.prepareImagePrompt(input, 'owner');
    const image = { prompt: input.prompt, size: input.size, requestId: input.requestId, optimizationToken: prepared.optimizationToken, referenceImages: ['  ' + png + ' ', jpg] };
    const result = await service.generateImageRequest(image, 'owner', 'image-key');
    assert.equal(result.originalPrompt, input.prompt);
    assert.equal(result.optimizedPrompt, prepared.optimizedPrompt);
    assert.equal(result.submittedPrompt, prepared.optimizedPrompt);
    assert.equal(result.optimization.status, 'applied');
    assert.equal(result.url, '/static/gen/fixture.png');
    assert.equal(result.tokens, 7);
    assert.equal(service.imageRequests[0].payload.size, 'auto');
    assert.deepEqual(service.imageRequests[0].payload.referenceImages, [png, jpg]);
    assert.equal(service.imageRequests[0].payload.prompt, prepared.optimizedPrompt);
    assert.deepEqual(await service.generateImageRequest(image, 'owner', 'image-key'), result);
    assert.equal(service.imageRequests.length, 1);
});
for (const [name, edit, owner, status] of [
    ['prompt', { prompt: 'changed' }, 'owner', 409], ['size', { size: '16:9' }, 'owner', 409],
    ['reference order', { referenceImages: [jpg, png] }, 'owner', 409], ['reference count', { referenceImages: [png] }, 'owner', 409],
    ['reference bytes', { referenceImages: [png, png] }, 'owner', 409], ['owner', {}, 'attacker', 400],
    ['request UUID', { requestId: randomUUID() }, 'owner', 400], ['missing UUID', { requestId: undefined }, 'owner', 400],
    ['invalid token', { optimizationToken: 'fake.token' }, 'owner', 400],
    ['URL references', { referenceImages: ['https://reference.invalid/1.png', jpg] }, 'owner', 400],
    ['invalid reference content', { referenceImages: ['data:image/png;base64,ZmFrZQ==', jpg] }, 'owner', 400],
]) {
    await check('optimization token rejects changed ' + name + ' before generation', async () => {
        const service = fixture();
        const input = preparation({ referenceHashes: [hash(png), hash(jpg)] });
        const prepared = await service.prepareImagePrompt(input, 'owner');
        const image = { prompt: input.prompt, size: input.size, requestId: input.requestId, optimizationToken: prepared.optimizationToken, referenceImages: [png, jpg], ...edit };
        await reject(() => service.generateImageRequest(image, owner, 'image-key'), status);
        assert.equal(service.imageRequests.length, 0);
    });
}
await check('tamper, expiry and restart invalidate tickets even with stable configured signing secret', async () => {
    const service = fixture();
    const input = preparation();
    const prepared = await service.prepareImagePrompt(input, 'owner');
    const image = { ...input, optimizationToken: prepared.optimizationToken };
    const [encoded, signature] = prepared.optimizationToken.split('.');
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    claims.optimizedPrompt = 'tampered';
    const tampered = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + signature;
    await reject(() => service.generateImageRequest({ ...image, optimizationToken: tampered }, 'owner', 'image-key'), 400);
    await reject(() => fixture().generateImageRequest(image, 'owner', 'image-key'), 400);
    service.clock.value += 300001;
    await reject(() => service.generateImageRequest(image, 'owner', 'image-key'), 410, 'OPTIMIZATION_TOKEN_EXPIRED');
    assert.equal(service.imageRequests.length, 0);
});
await check('expired ticket can recover only its exact already completed generation without a new charge', async () => {
    const service = fixture();
    const input = preparation({ referenceHashes: [hash(png), hash(jpg)] });
    const prepared = await service.prepareImagePrompt(input, 'owner');
    const image = { prompt: input.prompt, size: input.size, requestId: input.requestId,
        referenceImages: [png, jpg], optimizationToken: prepared.optimizationToken };
    const result = await service.generateImageRequest(image, 'owner', 'image-key');
    service.clock.value += 300001;
    assert.deepEqual(await service.generateImageRequest(image, 'owner', 'image-key'), result);
    await reject(() => service.generateImageRequest({ ...image, prompt: 'changed' }, 'owner', 'image-key'), 410);
    await reject(() => service.generateImageRequest({ ...image, referenceImages: [jpg, png] }, 'owner', 'image-key'), 410);
    await reject(() => service.generateImageRequest(image, 'another-owner', 'image-key'), 400);
    await reject(() => service.generateImageRequest({ ...image, optimizationToken: prepared.optimizationToken + 'a' }, 'owner', 'image-key'), 400);
    assert.equal(service.imageRequests.length, 1);
    service.clock.value += 30 * 60000;
    await reject(() => service.generateImageRequest(image, 'owner', 'image-key'), 410, 'OPTIMIZATION_TOKEN_EXPIRED');
    assert.equal(service.imageRequests.length, 1);
});
await check('expired ticket may join only its existing pending generation and cannot submit twice', async () => {
    const gate = pending();
    const service = fixture({ generator: async () => { await gate.promise; return { url: '/static/gen/fixture.png', revisedPrompt: '', tokens: 0 }; } });
    const input = preparation();
    const prepared = await service.prepareImagePrompt(input, 'owner');
    const image = { prompt: input.prompt, requestId: input.requestId, optimizationToken: prepared.optimizationToken };
    const first = service.generateImageRequest(image, 'owner', 'image-key');
    await delay(1);
    service.clock.value += 300001;
    const replay = service.generateImageRequest(image, 'owner', 'image-key');
    gate.resolve();
    assert.deepEqual(await first, await replay);
    assert.equal(service.imageRequests.length, 1);
});
await check('expired ticket replays cached unknown failure rather than launching a replacement', async () => {
    const service = fixture({ generator: async () => { throw Object.assign(new Error('sk-provider-secret'), { status: 504 }); } });
    const input = preparation();
    const prepared = await service.prepareImagePrompt(input, 'owner');
    const image = { prompt: input.prompt, requestId: input.requestId, optimizationToken: prepared.optimizationToken };
    await reject(() => service.generateImageRequest(image, 'owner', 'image-key'), 504, 'IMAGE_GENERATION_UNKNOWN');
    service.clock.value += 300001;
    await reject(() => service.generateImageRequest(image, 'owner', 'image-key'), 504, 'IMAGE_GENERATION_UNKNOWN');
    assert.equal(service.imageRequests.length, 1);
});
await check('new raw generation dedupes pending and finished results without re-consuming IP quota', async () => {
    const gate = pending();
    const service = fixture({ generator: async () => { await gate.promise; return { url: '/static/gen/fixture.png', revisedPrompt: '', tokens: 0 }; } });
    const input = { prompt: '原词直接生成', size: 'auto', referenceImages: [], requestId: randomUUID() };
    let limits = 0;
    const options = { allowGeneration: () => { limits++; return true; } };
    const first = service.generateImageRequest(input, 'owner', 'image-key', options);
    const second = service.generateImageRequest(input, 'owner', 'image-key', options);
    await delay(1);
    assert.equal(service.imageRequests.length, 1);
    gate.resolve();
    const result = await first;
    assert.deepEqual(await second, result);
    assert.deepEqual(await service.generateImageRequest(input, 'owner', 'image-key', options), result);
    assert.equal(result.optimization.status, 'disabled');
    assert.equal(result.submittedPrompt, input.prompt);
    assert.equal(limits, 1);
    await reject(() => service.generateImageRequest({ ...input, prompt: 'changed' }, 'owner', 'image-key'), 409, 'REQUEST_ID_CONFLICT');
});
await check('unknown generation errors are sanitized and cached, never automatically submitted again', async () => {
    const service = fixture({ generator: async () => { throw Object.assign(new Error('sk-provider-secret'), { status: 504 }); } });
    const input = { prompt: 'fixture', requestId: randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => service.generateImageRequest(input, 'owner', 'image-key'), error => error.status === 504 && error.code === 'IMAGE_GENERATION_UNKNOWN' && !error.message.includes('sk-provider-secret') && !error.allowOriginal);
    assert.equal(service.imageRequests.length, 1);
});
await check('256 free generation rate-limit failures cannot fill global cache or charge a new owner twice', async () => {
    const service = fixture();
    const limitedOptions = { allowGeneration: () => false };
    for (let attempt = 0; attempt < 256; attempt++) {
        await reject(() => service.generateImageRequest({ prompt: 'fixture', requestId: randomUUID() }, 'limited-owner', 'image-key', limitedOptions), 429, 'IMAGE_RATE_LIMITED');
    }
    assert.equal(service.imageRequests.length, 0);
    const input = { prompt: 'legitimate', requestId: randomUUID() };
    const result = await service.generateImageRequest(input, 'legitimate-owner', 'image-key');
    assert.deepEqual(await service.generateImageRequest(input, 'legitimate-owner', 'image-key'), result);
    assert.equal(service.imageRequests.length, 1);
});
await check('256 free generation busy failures cannot fill cache and a free rejected UUID can retry admission', async () => {
    const gate = pending();
    const service = fixture({ generator: async () => { await gate.promise; return { url: '/static/gen/fixture.png', revisedPrompt: '', tokens: 0 }; } });
    const first = service.generateImageRequest({ prompt: 'first', requestId: randomUUID() }, 'owner1', 'image-key');
    const second = service.generateImageRequest({ prompt: 'second', requestId: randomUUID() }, 'owner2', 'image-key');
    await delay(1);
    const retry = { prompt: 'legitimate', requestId: randomUUID() };
    for (let attempt = 0; attempt < 256; attempt++) {
        await reject(() => service.generateImageRequest(attempt === 0 ? retry : { prompt: 'fixture', requestId: randomUUID() }, 'limited-owner', 'image-key'), 503, 'IMAGE_BUSY');
    }
    gate.resolve();
    await Promise.all([first, second]);
    const result = await service.generateImageRequest(retry, 'limited-owner', 'image-key');
    assert.deepEqual(await service.generateImageRequest(retry, 'limited-owner', 'image-key'), result);
    assert.equal(service.imageRequests.length, 3);
});
await check('post-submission safety and provider rate failures remain cached using internal attempt state', async () => {
    for (const status of [422, 429]) {
        const service = fixture({ generator: async () => { throw Object.assign(new Error('sk-provider-secret'), { status, code: 'REQUEST_CANCELLED' }); } });
        const input = { prompt: 'fixture', requestId: randomUUID() };
        for (let attempt = 0; attempt < 2; attempt++) await reject(() => service.generateImageRequest(input, 'owner', 'image-key'), status);
        assert.equal(service.imageRequests.length, 1);
    }
});
await check('generation before-submit abort is free, while submitted work can finish and be replayed after disconnect', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const service = fixture();
    await reject(() => service.generateImageRequest({ prompt: 'fixture', requestId: randomUUID() }, 'owner', 'key', { signal: stopped.signal }), 499);
    assert.equal(service.imageRequests.length, 0);
    const controller = new AbortController();
    const gate = pending();
    const submitted = fixture({ generator: async () => { await gate.promise; return { url: '/static/gen/fixture.png', revisedPrompt: '', tokens: 0 }; } });
    const input = { prompt: 'fixture', requestId: randomUUID() };
    const operation = submitted.generateImageRequest(input, 'owner', 'key', { signal: controller.signal });
    await delay(1);
    controller.abort();
    gate.resolve();
    const result = await operation;
    assert.deepEqual(await submitted.generateImageRequest(input, 'owner', 'key'), result);
    assert.equal(submitted.imageRequests.length, 1);
});
await check('legacy no-token URL reference remains available and is never fetched by optimizer', async () => {
    const service = fixture({ env: { PROMPT_OPTIMIZER_ENABLED: '' } });
    const result = await service.generateImageRequest({ prompt: 'fixture', referenceImage: 'http://reference.invalid/legacy.png' }, 'owner', 'key');
    assert.equal(result.optimization.status, 'disabled');
    assert.deepEqual(service.imageRequests[0].payload.referenceImages, ['http://reference.invalid/legacy.png']);
    assert.equal(service.optimizerRequests.length, 0);
});
await check('generation global concurrency and hourly call budget remain independent of optimizer', async () => {
    const gate = pending();
    const concurrent = fixture({ generator: async () => { await gate.promise; return { url: '/static/gen/fixture.png' }; } });
    const first = concurrent.generateImageRequest({ prompt: 'one', requestId: randomUUID() }, 'one', 'key');
    const second = concurrent.generateImageRequest({ prompt: 'two', requestId: randomUUID() }, 'two', 'key');
    await delay(1);
    await reject(() => concurrent.generateImageRequest({ prompt: 'three', requestId: randomUUID() }, 'three', 'key'), 503, 'IMAGE_BUSY');
    gate.resolve();
    await Promise.all([first, second]);
    const service = fixture();
    for (let attempt = 0; attempt < 120; attempt++) await service.generateImageRequest({ prompt: 'fixture', requestId: randomUUID() }, 'owner-' + attempt, 'key');
    await reject(() => service.generateImageRequest({ prompt: 'fixture', requestId: randomUUID() }, 'over-budget', 'key'), 503, 'IMAGE_BUDGET_LIMITED');
    assert.equal(service.imageRequests.length, 120);
    assert.equal(service.optimizerRequests.length, 0);
});
await check('server prepare parser rejects 64KB overflow and malformed JSON safely; health reveals no key', async () => {
    const source = await readFile(new URL('../../server.js', import.meta.url), 'utf8');
    const service = fixture();
    let backend;
    const intervals = [];
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
        process: { env: { PORT: '0' } }, console: { log() {}, error() {} },
        API_BASE: 'https://fixture.invalid', MODEL: 'fixture-chat', MAX_TOKENS: 2048, TEMPERATURE: 0.5,
        buildMessages() { throw new Error('must not reuse persona'); }, getApiKey: () => 'fixture-key',
        IMAGE_MODEL: 'fixture-image', getImageApiKey: () => 'image-key', renderMarkdown: value => value,
        createImageJobService: () => ({ health: () => ({ ready: true }), init: async () => {}, createJob: async () => { throw new Error('Fixture jobs disabled'); }, getJob: async () => { throw new Error('Fixture jobs disabled'); } }),
        ...service, fetch() { throw new Error('no real API calls'); }, AbortController, TextDecoder,
        setTimeout, clearTimeout, setInterval: (...args) => { const timer = setInterval(...args); intervals.push(timer); return timer; }, clearInterval });
    try {
        vm.runInContext(source.replace(/^import .+;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../../server.js', import.meta.url).href)), context);
        await once(backend, 'listening');
        const base = `http://127.0.0.1:${backend.address().port}`;
        const health = await (await fetch(base + '/api/health')).json();
        assert.equal(health.promptOptimizationReady, true);
        assert.equal(health.promptOptimizationMode, 'text');
        assert.equal(JSON.stringify(health).includes('fixture-key'), false);
        for (const [body, expected] of [[JSON.stringify({ prompt: 'x'.repeat(65537) }), 413], ['{"broken":', 400]]) {
            const result = await fetch(base + '/api/image/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            assert.equal(result.status, expected);
            assert.equal(result.headers.get('content-type').includes('application/json'), true);
            const data = await result.json();
            assert.equal(data.code, 'INVALID_IMAGE_INPUT');
            assert.equal(JSON.stringify(data).includes('stack'), false);
        }
        const input = preparation();
        const prepared = await (await fetch(base + '/api/image/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json();
        assert.equal(prepared.status, 'ready');
        const image = { prompt: input.prompt, requestId: input.requestId, optimizationToken: prepared.optimizationToken };
        const result = await (await fetch(base + '/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(image) })).json();
        assert.equal(result.status, 'ok');
        assert.equal(result.optimization.status, 'applied');
        assert.equal(service.optimizerRequests.length, 1);
        assert.equal(service.imageRequests.length, 1);
    } finally {
        for (const timer of intervals) clearInterval(timer);
        backend?.closeAllConnections();
        if (backend) await new Promise(resolve => backend.close(resolve));
    }
});

const report = { at: new Date().toISOString(), mockOnly: true, providerCalls: 0, physicalImageWrites: 0,
    passed: checks.every(item => item.passed), checks };
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, providerCalls: 0, failures: checks.filter(item => !item.passed) }));
if (!report.passed) process.exitCode = 1;
