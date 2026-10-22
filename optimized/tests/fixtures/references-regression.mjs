import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../../api/image_gen.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '/mock';")
    .replace(/^export /gm, '');
const compile = new Function('dependencies', 'const { mkdir,readdir,stat,unlink,writeFile,randomBytes,path,IMAGE_API_URL,IMAGE_MODEL,IMAGE_TIMEOUT,fetch,setTimeout,clearTimeout } = dependencies;\n' + source + '\nreturn { generateImage };');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfqoAAAAASUVORK5CYII=', 'base64');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
const checks = [];
function harness() {
    const requests = [];
    const writes = [];
    const module = compile({
        mkdir: async () => {}, readdir: async () => [], stat: async () => ({}), unlink: async () => {},
        writeFile: async (filename, body) => writes.push({filename, body}), randomBytes: crypto.randomBytes, path,
        IMAGE_API_URL: 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation', IMAGE_MODEL: 'hy-image-v3.5-preview', IMAGE_TIMEOUT: 150000,
        async fetch(url, options) {
            requests.push({url: String(url), options, payload: JSON.parse(options.body)});
            return new Response(JSON.stringify({data: [{b64_json: png.toString('base64')}]}), {headers: {'Content-Type': 'application/json'}});
        },
        setTimeout, clearTimeout
    });
    return {...module, requests, writes};
}
async function check(name, task) {
    try {await task(); checks.push({name, passed: true});}
    catch (error) {checks.push({name, passed: false, error: error.stack});}
}
async function rejected(payload, status) {
    const test = harness();
    await assert.rejects(() => test.generateImage({prompt: 'local fixture', ...payload}, 'fake-key'), error => error.status === status);
    assert.equal(test.requests.length, 0);
    assert.equal(test.writes.length, 0);
}
await check('multiple references preserve original order and content', async () => {
    const test = harness();
    const references = [dataUrl, 'https://reference.invalid/second.png', 'https://reference.invalid/third.jpg'];
    await test.generateImage({prompt: 'local fixture', referenceImages: references}, 'fake-key');
    const content = test.requests[0].payload.messages[0].content;
    assert.deepEqual(content[0], {type: 'text', text: 'local fixture'});
    assert.deepEqual(content.slice(1).map(item => item.image_url.url), references);
});
await check('twenty reference images allowed without truncation', async () => {
    const test = harness();
    const references = Array.from({length: 20}, (_, index) => 'https://reference.invalid/' + index + '.png');
    await test.generateImage({prompt: 'fixture', referenceImages: references}, 'fake-key');
    assert.equal(test.requests[0].payload.messages[0].content.length, 21);
    assert.deepEqual(test.requests[0].payload.messages[0].content.slice(1).map(item => item.image_url.url), references);
});
await check('legacy single reference remains supported', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture', referenceImage: dataUrl}, 'fake-key');
    assert.equal(test.requests[0].payload.messages[0].content[1].image_url.url, dataUrl);
});
await check('new array takes precedence over old field without duplicated references', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture', referenceImages: [dataUrl], referenceImage: 'https://reference.invalid/legacy.png'}, 'fake-key');
    assert.equal(test.requests[0].payload.messages[0].content.length, 2);
});
await check('empty new array explicitly produces text-only request', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture', referenceImages: [], referenceImage: dataUrl}, 'fake-key');
    assert.equal(test.requests[0].payload.messages[0].content.length, 1);
});
await check('missing references still produce text-only request', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture'}, 'fake-key');
    assert.equal(test.requests[0].payload.messages[0].content.length, 1);
});
await check('twenty-one references rejected before provider request', () => rejected({referenceImages: Array(21).fill(dataUrl)}, 400));
for (const value of [null, {}, 7, 'https://reference.invalid/one.png']) {
    await check('non-array referenceImages rejected: ' + typeof value, () => rejected({referenceImages: value}, 400));
}
for (const value of ['', '  ', null, {}, false, []]) {
    await check('invalid reference array element rejected: ' + JSON.stringify(value), () => rejected({referenceImages: [dataUrl, value]}, 400));
}
await check('malformed reference base64 rejected before provider request', () => rejected({referenceImages: ['data:image/png;base64,aGVsbG8=']}, 400));
await check('combined image budget rejected before decoding or provider request', async () => {
    const prefix = 'https://reference.invalid/';
    const reference = prefix + 'a'.repeat(7_000_001 - prefix.length);
    await rejected({referenceImages: [reference, reference]}, 413);
});
await check('combined image budget boundary remains allowed', async () => {
    const prefix = 'https://reference.invalid/';
    const reference = prefix + 'a'.repeat(7_000_000 - prefix.length);
    const test = harness();
    await test.generateImage({prompt: 'fixture', referenceImages: [reference, reference]}, 'fake-key');
    assert.equal(test.requests.length, 1);
});
await check('auto size omits both explicit dimensions and pixel tier for semantic adaptation', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture', size: 'auto', generate_max_pixels: 16777216, referenceImages: [dataUrl]}, 'fake-key');
    assert.equal('size' in test.requests[0].payload, false);
    assert.equal('generate_max_pixels' in test.requests[0].payload, false);
    assert.equal(test.requests[0].payload.messages[0].content.length, 2);
});
await check('default size remains exact 2048 square', async () => {
    const test = harness();
    await test.generateImage({prompt: 'fixture'}, 'fake-key');
    assert.equal(test.requests[0].payload.size, '2048x2048');
    assert.equal('generate_max_pixels' in test.requests[0].payload, false);
});
for (const [size, expected] of [['3:4', '1536x2048'], ['4:3', '2048x1536'], ['9:16', '1152x2048'], ['16:9', '2048x1152']]) {
    await check('fixed preset unchanged: ' + size, async () => {
        const test = harness();
        await test.generateImage({prompt: 'fixture', size}, 'fake-key');
        assert.equal(test.requests[0].payload.size, expected);
        assert.equal('generate_max_pixels' in test.requests[0].payload, false);
    });
}
await check('unknown size rejected before provider request', () => rejected({size: '4096x4096'}, 400));
const report = {at: new Date().toISOString(), mockOnly: true, providerCalls: 0, physicalImageWrites: 0, passed: checks.every(entry => entry.passed), checks};
console.log(JSON.stringify({passed: report.passed, checks: checks.length, failures: checks.filter(entry => !entry.passed)}));
if (!report.passed) process.exitCode = 1;
