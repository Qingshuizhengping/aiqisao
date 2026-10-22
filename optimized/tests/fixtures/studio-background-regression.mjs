import assert from 'node:assert/strict';
import { setup, png } from '../helpers/studio-dom.mjs';

const prefix = 'qisao_studio_job:';
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const health = { imageReady: true, imageJobsReady: true, promptOptimizationReady: true, promptOptimizationMode: 'text' };
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const checks = [];

async function check(name, operation) {
    await operation();
    checks.push(name);
}

function fixture() {
    const storage = new Map();
    const jobs = new Map();
    const uploads = [];
    const calls = [];
    async function handler(url, options) {
        calls.push({ url, method: options.method });
        if (options.method === 'POST') {
            const payload = JSON.parse(options.body);
            uploads.push(payload);
            const job = { id: payload.requestId, originalPrompt: payload.prompt, size: payload.size,
                referenceCount: payload.referenceImages?.length || 0, state: 'generating' };
            jobs.set(job.id, job);
            return reply(202, { status: 'ok', job });
        }
        const job = jobs.get(url.split('/').at(-1));
        return reply(job ? 200 : 404, job ? { status: 'ok', job } : { status: 'error' });
    }
    return { storage, jobs, uploads, calls, async open(options = {}) {
        const page = await setup({ storage, health, virtualTimers: true, jobHandler: handler, ...options });
        await pause();
        return page;
    } };
}

async function generate(page, prompt) {
    page.elements.prompt.value = prompt;
    await page.elements.generateBtn.click();
    await pause();
}

await check('same-page ordered reference previews and names survive the initial job publication', async () => {
    const backend = fixture();
    const page = await backend.open();
    page.elements.refInput.files = ['first.png', 'second.png'].map(name => ({ name, type: 'image/png', size: 100, dataUrl: png }));
    await page.elements.refInput.dispatch('change');
    await page.elements.sizeChips.children[2].click();
    await generate(page, '玻璃杯视觉，保留两张参考图');
    assert.equal(backend.uploads.length, 1);
    assert.equal(backend.uploads[0].referenceImages.length, 2);
    assert.equal(backend.uploads[0].size, 'auto');
    assert.equal(page.elements.refPreview.children.length, 2);
    assert.equal(page.elements.refPreview.children[0].children[0].title, 'first.png');
    assert.equal(page.elements.refPreview.children[1].children[0].title, 'second.png');
    assert.equal(page.elements.generateBtn.disabled, true);
    assert.equal([...backend.storage.values()].some(value => value.includes('data:image')), false);
    const reloaded = await backend.open();
    assert.equal(backend.uploads.length, 1);
    assert.equal(reloaded.elements.prompt.value, backend.uploads[0].prompt);
    assert.equal(reloaded.elements.sizeNote.textContent, '自动 · 模型自适应');
    assert.equal(reloaded.elements.generateBtn.disabled, true);
});

await check('old tab completion cannot erase a newer paid job or stop its reload recovery', async () => {
    const backend = fixture();
    const first = await backend.open();
    await generate(first, 'task A');
    const taskA = backend.uploads[0].requestId;
    const second = await backend.open();
    second.document.hidden = true;
    second.document.dispatch('visibilitychange');
    backend.jobs.set(taskA, { ...backend.jobs.get(taskA), state: 'succeeded', result: { url: '/static/gen/task-A.png' } });
    first.window.dispatch('online');
    await pause();
    assert.equal(first.elements.stageResult.hidden, false);
    await generate(first, 'task B');
    const taskB = backend.uploads[1].requestId;
    second.document.hidden = false;
    second.document.dispatch('visibilitychange');
    await pause();
    assert.equal(second.elements.stageResult.hidden, false);
    assert.equal(backend.storage.has(prefix + taskB), true);
    assert.equal(backend.storage.has(prefix + taskA), false);
    const before = backend.calls.length;
    const reloaded = await backend.open();
    assert.equal(reloaded.elements.prompt.value, 'task B');
    assert.equal(reloaded.elements.generateBtn.disabled, true);
    assert.equal(backend.uploads.length, 2);
    assert.ok(backend.calls.slice(before).some(call => call.method === 'GET' && call.url.endsWith(taskB)));
});

await check('unavailable browser storage rejects before uploading a chargeable job', async () => {
    const backend = fixture();
    const page = await backend.open({ failStorage: true });
    await generate(page, 'storage failure');
    assert.equal(backend.uploads.length, 0);
    assert.match(page.elements.errorText.textContent, /无法保存后台任务凭据/);
    assert.equal(page.elements.generateBtn.disabled, false);
});

await check('late results from an old tab merge with the latest completed image history', async () => {
    const backend = fixture();
    const first = await backend.open();
    await generate(first, 'history A');
    const taskA = backend.uploads[0].requestId;
    const second = await backend.open();
    second.document.hidden = true;
    second.document.dispatch('visibilitychange');
    backend.jobs.set(taskA, { ...backend.jobs.get(taskA), state: 'succeeded', result: { url: '/static/gen/history-A.png' } });
    first.window.dispatch('online');
    await pause();
    await generate(first, 'history B');
    const taskB = backend.uploads[1].requestId;
    backend.jobs.set(taskB, { ...backend.jobs.get(taskB), state: 'succeeded', result: { url: '/static/gen/history-B.png' } });
    first.window.dispatch('online');
    await pause();
    assert.equal(JSON.parse(backend.storage.get('qisao_studio_history')).length, 2);
    second.document.hidden = false;
    second.document.dispatch('visibilitychange');
    await pause();
    assert.equal(second.elements.stageResult.hidden, false);
    const history = JSON.parse(backend.storage.get('qisao_studio_history'));
    assert.deepEqual(history.map(entry => entry.url).sort(), ['/static/gen/history-A.png', '/static/gen/history-B.png']);
    assert.equal(backend.uploads.length, 2);
});

await check('failed restored reference jobs require replacement references before another POST', async () => {
    const backend = fixture();
    const id = '4aa39666-7f39-4cad-a229-d061370ef30e';
    backend.storage.set(prefix + id, JSON.stringify({ id, token: 'b'.repeat(64), createdAt: Date.now(), accepted: true,
        prompt: '参考图产品视觉', size: 'auto', referenceCount: 2, optimizationEnabled: true }));
    backend.jobs.set(id, { id, originalPrompt: '参考图产品视觉', size: 'auto', referenceCount: 2,
        state: 'failed', error: 'mock failure', code: 'OPTIMIZATION_UNAVAILABLE' });
    const page = await backend.open();
    assert.equal(page.elements.stageError.hidden, false);
    await page.elements.generateBtn.click();
    assert.equal(backend.uploads.length, 0);
    assert.match(page.elements.errorText.textContent, /重新上传至少一张参考图/);
});

await check('degraded backend health prevents silent synchronous generation fallback', async () => {
    const backend = fixture();
    const page = await backend.open({ health: { ...health, imageJobsReady: false,
        imageJobsStatus: { ready: false, code: 'IMAGE_JOB_STORAGE_UNAVAILABLE' } } });
    assert.equal(page.elements.generateBtn.disabled, true);
    assert.match(page.elements.serviceStatus.textContent, /后台任务存储异常/);
    assert.equal(backend.uploads.length + page.requests.length + page.preparations.length, 0);
});

await check('failed result history persistence retains its capability until a later page saves the result', async () => {
    const backend = fixture();
    const page = await backend.open({ failHistory: true });
    await generate(page, 'recover result after history storage failure');
    const id = backend.uploads[0].requestId;
    backend.jobs.set(id, { ...backend.jobs.get(id), state: 'succeeded', result: { url: '/static/gen/history-quota.png' } });
    page.window.dispatch('online');
    await pause();
    assert.equal(page.elements.stageResult.hidden, false);
    assert.equal(backend.storage.has(prefix + id), true);
    assert.equal(backend.storage.has('qisao_studio_history'), false);
    const reloaded = await backend.open();
    assert.equal(reloaded.elements.stageResult.hidden, false);
    assert.equal(backend.uploads.length, 1);
    assert.equal(backend.storage.has(prefix + id), false);
    assert.equal(JSON.parse(backend.storage.get('qisao_studio_history'))[0].url, '/static/gen/history-quota.png');
});

await check('a reference batch cannot mutate the task restored while its files are being read', async () => {
    const backend = fixture();
    let releaseRead;
    let startedRead;
    const reading = new Promise(resolve => { startedRead = resolve; });
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const page = await backend.open({ readFile: async () => { startedRead(); await gate; } });
    page.elements.prompt.value = 'draft A';
    page.elements.refInput.files = [{ name: 'draft-A.png', type: 'image/png', size: 100, dataUrl: png }];
    const selecting = page.elements.refInput.dispatch('change');
    await reading;
    const id = '839953a4-51ac-4315-b528-3016da2e3e9a';
    const record = { id, token: 'c'.repeat(64), createdAt: Date.now(), accepted: true,
        prompt: 'restored task B', size: 'auto', referenceCount: 0, optimizationEnabled: true };
    backend.storage.set(prefix + id, JSON.stringify(record));
    backend.jobs.set(id, { id, originalPrompt: record.prompt, size: record.size, referenceCount: 0, state: 'generating' });
    page.window.dispatch('storage', { key: prefix + id });
    await pause();
    assert.equal(page.elements.prompt.value, record.prompt);
    releaseRead();
    await selecting;
    assert.equal(page.elements.refPreview.children.length, 0);
    assert.equal(page.elements.stageLoading.hidden, false);
    assert.equal(page.elements.stageError.hidden, true);
    assert.equal(page.elements.generateBtn.disabled, true);
    assert.equal(backend.uploads.length + page.requests.length, 0);
});

await check('a stale reference read failure cannot replace the restored task status', async () => {
    const backend = fixture();
    let rejectRead;
    let startedRead;
    const reading = new Promise(resolve => { startedRead = resolve; });
    const gate = new Promise((resolve, reject) => { rejectRead = reject; });
    const page = await backend.open({ readFile: async () => { startedRead(); await gate; } });
    page.elements.refInput.files = [{ name: 'draft-A.png', type: 'image/png', size: 100, dataUrl: png }];
    const selecting = page.elements.refInput.dispatch('change');
    await reading;
    const id = 'bbcb9cad-95e0-45a4-8718-05a37fecefbf';
    const record = { id, token: 'd'.repeat(64), createdAt: Date.now(), accepted: true,
        prompt: 'task B survives old read failure', size: '1:1', referenceCount: 0, optimizationEnabled: true };
    backend.storage.set(prefix + id, JSON.stringify(record));
    backend.jobs.set(id, { id, originalPrompt: record.prompt, size: record.size, referenceCount: 0, state: 'generating' });
    page.window.dispatch('storage', { key: prefix + id });
    await pause();
    rejectRead(new Error('old reference read failed'));
    await selecting;
    assert.equal(page.elements.prompt.value, record.prompt);
    assert.equal(page.elements.refPreview.children.length, 0);
    assert.equal(page.elements.stageLoading.hidden, false);
    assert.equal(page.elements.stageError.hidden, true);
    assert.equal(backend.uploads.length + page.requests.length, 0);
});

await check('failed history clear preserves displayed and persisted records and reports the failure', async () => {
    const backend = fixture();
    const saved = JSON.stringify([{ url: '/static/gen/keep-history.png', prompt: 'saved image', ts: Date.now() }]);
    backend.storage.set('qisao_studio_history', saved);
    const page = await backend.open({ failHistory: true });
    assert.equal(page.elements.historyGrid.children.length, 1);
    await page.elements.historyClear.click();
    assert.equal(page.elements.historyGrid.children.length, 1);
    assert.equal(page.elements.historyClear.hidden, false);
    assert.equal(backend.storage.get('qisao_studio_history'), saved);
    const visibleMessage = (page.elements.serviceStatus.hidden ? '' : page.elements.serviceStatus.textContent) +
        (page.elements.stageError.hidden ? '' : page.elements.errorText.textContent);
    assert.match(visibleMessage, /失败|无法|未能/);
    assert.equal(backend.uploads.length + page.requests.length, 0);
    const reloaded = await backend.open();
    assert.equal(reloaded.elements.historyGrid.children.length, 1);
    await reloaded.elements.historyClear.click();
    assert.equal(reloaded.elements.historyGrid.children.length, 0);
    assert.equal(reloaded.elements.historyClear.hidden, true);
    assert.deepEqual(JSON.parse(backend.storage.get('qisao_studio_history') || '[]'), []);
});

await check('legacy successful generation keeps its result visible and reports failed history persistence without repeating the request', async () => {
    const backend = fixture();
    const saved = JSON.stringify([{ url: '/static/gen/existing-history.png', prompt: 'existing image', ts: Date.now() }]);
    backend.storage.set('qisao_studio_history', saved);
    const page = await backend.open({ failHistory: true, health: { imageReady: true,
        promptOptimizationReady: true, promptOptimizationMode: 'text' } });
    await generate(page, 'legacy result with full storage');
    assert.equal(page.elements.stageResult.hidden, false);
    assert.equal(page.elements.resultImg.src, '/static/gen/fixture.png');
    assert.equal(page.elements.downloadBtn.href, '/static/gen/fixture.png');
    assert.equal(page.elements.serviceStatus.hidden, false);
    assert.match(page.elements.serviceStatus.textContent, /历史.*保存失败/);
    assert.equal(backend.storage.get('qisao_studio_history'), saved);
    assert.equal(page.elements.historyGrid.children.length, 1);
    assert.equal(page.preparations.length, 1);
    assert.equal(page.requests.length, 1);
    page.window.dispatch('online');
    page.document.dispatch('visibilitychange');
    await pause();
    assert.equal(page.requests.length, 1);
    assert.equal(backend.uploads.length, 0);
});

for (const phase of ['prepare', 'image']) {
    for (const failed of [false, true]) {
        await check('legacy ' + phase + ' ' + (failed ? 'failure' : 'success') + ' cannot overwrite a concurrently restored background task', async () => {
            const backend = fixture();
            let releaseLegacy;
            let notifyStarted;
            const legacyGate = new Promise(resolve => { releaseLegacy = resolve; });
            const legacyStarted = new Promise(resolve => { notifyStarted = resolve; });
            const page = await backend.open({
                health: { imageReady: true, promptOptimizationReady: true, promptOptimizationMode: 'text' },
                prepare: async payload => {
                    if (phase === 'prepare') {
                        notifyStarted();
                        await legacyGate;
                        if (failed) throw new TypeError('old preparation failed');
                    }
                    return reply(200, { status: 'ready', optimizationToken: 'legacy-token',
                        originalPrompt: payload.prompt, optimizedPrompt: 'optimized legacy A' });
                },
                image: async () => {
                    if (phase === 'image') {
                        notifyStarted();
                        await legacyGate;
                        if (failed) throw new TypeError('old image response failed');
                    }
                    return reply(200, { status: 'ok', url: '/static/gen/legacy-A.png' });
                },
            });
            page.elements.prompt.value = 'legacy A';
            const generating = page.elements.generateBtn.click();
            await legacyStarted;
            const id = '4a42ad4f-d83d-4514-9314-7d464a9641f5';
            const record = { id, token: 'e'.repeat(64), createdAt: Date.now(), accepted: true,
                prompt: 'background B', size: 'auto', referenceCount: 0, optimizationEnabled: true };
            backend.storage.set(prefix + id, JSON.stringify(record));
            backend.jobs.set(id, { id, originalPrompt: record.prompt, size: record.size, referenceCount: 0, state: 'generating' });
            page.window.dispatch('storage', { key: prefix + id });
            await pause();
            releaseLegacy();
            await generating;
            await pause();
            assert.equal(page.elements.prompt.value, record.prompt);
            assert.equal(page.elements.stageLoading.hidden, false);
            assert.equal(page.elements.stageError.hidden, true);
            assert.equal(page.elements.stageResult.hidden, true);
            assert.equal(page.elements.useOriginalBtn.hidden, true);
            assert.equal(page.elements.generateBtn.disabled, true);
            assert.equal(backend.storage.has(prefix + id), true);
            assert.equal(page.preparations.length, 1);
            assert.equal(page.requests.length, phase === 'prepare' && failed ? 0 : 1);
            assert.equal(backend.uploads.length, 0);
            const history = JSON.parse(backend.storage.get('qisao_studio_history') || '[]');
            assert.deepEqual(history.map(entry => entry.url), failed ? [] : ['/static/gen/legacy-A.png']);
            if (!failed) assert.equal(history[0].prompt, 'legacy A');
            await page.elements.generateBtn.click();
            assert.equal(page.requests.length, phase === 'prepare' && failed ? 0 : 1);
            assert.equal(backend.uploads.length, 0);
        });
    }
}

await check('an unsaved legacy result stays downloadable while a background task continues until explicit selection', async () => {
    const backend = fixture();
    let releaseImage;
    let notifyStarted;
    const imageGate = new Promise(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise(resolve => { notifyStarted = resolve; });
    const page = await backend.open({ failHistory: true,
        health: { imageReady: true, promptOptimizationReady: true, promptOptimizationMode: 'text' },
        image: async () => { notifyStarted(); await imageGate; return reply(200, { status: 'ok', url: '/static/gen/unsaved-legacy-A.png' }); },
    });
    page.elements.prompt.value = 'legacy A with full storage';
    const generating = page.elements.generateBtn.click();
    await imageStarted;
    const id = 'a57c099b-a847-43c0-a385-f8851228cab9';
    const record = { id, token: 'f'.repeat(64), createdAt: Date.now(), accepted: true,
        prompt: 'background B remains recoverable', size: 'auto', referenceCount: 0, optimizationEnabled: true };
    backend.storage.set(prefix + id, JSON.stringify(record));
    backend.jobs.set(id, { id, originalPrompt: record.prompt, size: record.size, referenceCount: 0, state: 'generating' });
    page.window.dispatch('storage', { key: prefix + id });
    await pause();
    releaseImage();
    await generating;
    await pause();
    assert.equal(page.elements.stageResult.hidden, false);
    assert.equal(page.elements.resultImg.src, '/static/gen/unsaved-legacy-A.png');
    assert.equal(page.elements.downloadBtn.href, '/static/gen/unsaved-legacy-A.png');
    assert.equal(page.elements.serviceStatus.hidden, false);
    assert.match(page.elements.serviceStatus.textContent, /历史.*保存失败.*先下载/);
    assert.equal(backend.storage.has('qisao_studio_history'), false);
    assert.equal(backend.storage.has(prefix + id), true);
    const readsBeforeWake = backend.calls.filter(call => call.method === 'GET').length;
    page.window.dispatch('online');
    await pause();
    assert.ok(backend.calls.filter(call => call.method === 'GET').length > readsBeforeWake);
    assert.equal(page.elements.stageResult.hidden, false);
    assert.equal(page.elements.resultImg.src, '/static/gen/unsaved-legacy-A.png');
    const selector = page.elements.serviceStatus.parentElement.querySelectorAll('select')[0];
    assert.ok(selector);
    assert.equal(selector.disabled, false);
    assert.equal(selector.parentElement.hidden, false);
    selector.value = id;
    await selector.dispatch('change');
    await pause();
    assert.equal(page.elements.prompt.value, record.prompt);
    assert.equal(page.elements.stageLoading.hidden, false);
    assert.equal(backend.storage.has(prefix + id), true);
    assert.equal(page.requests.length, 1);
    assert.equal(backend.uploads.length, 0);
});

await check('explicit legacy original-prompt fallback also restores a concurrent background task after saving its image', async () => {
    const backend = fixture();
    let releaseImage;
    let notifyStarted;
    const imageGate = new Promise(resolve => { releaseImage = resolve; });
    const imageStarted = new Promise(resolve => { notifyStarted = resolve; });
    const page = await backend.open({ health: { imageReady: true, promptOptimizationReady: true, promptOptimizationMode: 'text' },
        prepare: async () => reply(503, { code: 'OPTIMIZATION_UNAVAILABLE', allowOriginal: true, error: 'optimizer unavailable' }),
        image: async () => { notifyStarted(); await imageGate; return reply(200, { status: 'ok', url: '/static/gen/fallback-A.png' }); },
    });
    await generate(page, 'explicit original A');
    assert.equal(page.elements.useOriginalBtn.hidden, false);
    const generating = page.elements.useOriginalBtn.click();
    await imageStarted;
    const id = '93160c2d-894e-4915-a24f-64feb5a3d783';
    const record = { id, token: 'a'.repeat(64), createdAt: Date.now(), accepted: true,
        prompt: 'background B during fallback', size: 'auto', referenceCount: 0, optimizationEnabled: true };
    backend.storage.set(prefix + id, JSON.stringify(record));
    backend.jobs.set(id, { id, originalPrompt: record.prompt, size: record.size, referenceCount: 0, state: 'generating' });
    page.window.dispatch('storage', { key: prefix + id });
    await pause();
    releaseImage();
    await generating;
    await pause();
    assert.equal(page.elements.prompt.value, record.prompt);
    assert.equal(page.elements.stageLoading.hidden, false);
    assert.equal(page.elements.stageResult.hidden, true);
    assert.equal(page.elements.stageError.hidden, true);
    assert.equal(backend.storage.has(prefix + id), true);
    const history = JSON.parse(backend.storage.get('qisao_studio_history'));
    assert.equal(history[0].url, '/static/gen/fallback-A.png');
    assert.equal(history[0].prompt, 'explicit original A');
    assert.equal(page.preparations.length, 1);
    assert.equal(page.requests.length, 1);
    assert.equal('optimizationToken' in page.requests[0], false);
    assert.equal(backend.uploads.length, 0);
});

console.log(JSON.stringify({ passed: true, checks: checks.length, providerCalls: 0 }));
