import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const baseline = process.argv.includes('--baseline');
const sourceText = baseline ? execFileSync('git', ['show', '5f1a45c:optimized/api/image_gen.js'], { encoding: 'utf8', windowsHide: true }) : fs.readFileSync(new URL('../../api/image_gen.js', import.meta.url), 'utf8');
const source = sourceText
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '/mock';")
    .replace(/^export /gm, '');
const compile = new Function('dependencies', 'const { mkdir,readdir,stat,unlink,writeFile,randomBytes,path,IMAGE_API_URL,IMAGE_MODEL,IMAGE_TIMEOUT,fetch,setTimeout,clearTimeout } = dependencies;\n' + source + '\nreturn { generateImage, imageDownloadUrl };');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfqoAAAAASUVORK5CYII=', 'base64');
const currentHost = 'aigc-output-image-file-1326893053.cos.ap-guangzhou.myqcloud.com';
const otherBuckets = [
    'aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com',
    'hy-image-output-1250000000.cos.ap-guangzhou.myqcloud.com',
    'image-results-1326893053.cos.ap-shanghai.myqcloud.com',
    'generated-art-1250000000.cos.eu-frankfurt.myqcloud.com',
    'generated-art-1250000000.cos.na-ashburn.myqcloud.com',
    'generated-art-1250000000.cos.sa-saopaulo.myqcloud.com',
    'generated-art-1250000000.cos.me-saudi-riyadh.myqcloud.com',
];
const extraIndex = process.argv.indexOf('--host');
if (extraIndex >= 0) {
    const host = process.argv[extraIndex + 1];
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error('--host accepts a hostname only, never a signed URL');
    if (!otherBuckets.includes(host)) otherBuckets.push(host);
}
const checks = [];
function harness(respond) {
    const requests = [];
    const writes = [];
    const module = compile({
        mkdir: async () => {}, readdir: async () => [], stat: async () => ({}), unlink: async () => {},
        writeFile: async (filename, body) => writes.push({ filename, body }), randomBytes: crypto.randomBytes, path,
        IMAGE_API_URL: 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',
        IMAGE_MODEL: 'hy-image-v3.5-preview', IMAGE_TIMEOUT: 150000,
        async fetch(url, options) { requests.push({ url: String(url), options }); return respond(requests.length, url, options); },
        setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, 1000)), clearTimeout,
    });
    return { ...module, requests, writes };
}
function result(url) {
    return new Response(JSON.stringify({ choices: [{ delta: { image: { url } } }] }), { headers: { 'Content-Type': 'application/json' } });
}
async function check(name, task) {
    try { await task(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.stack }); }
}

await check('existing documented COS URL still downloads without provider Bearer', async () => {
    const url = 'https://' + currentHost + '/output/image.png?signature=fixture';
    const test = harness(count => count === 1 ? result(url) : new Response(png));
    const image = await test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token');
    assert.equal(test.requests.length, 2);
    assert.equal(test.requests[1].options.headers, undefined);
    assert.match(image.url, /^\/static\/gen\/.+\.png$/);
    assert.equal(test.writes.length, 1);
});

for (const host of otherBuckets) {
    await check((baseline ? 'baseline reproduces erroneous rejection: ' : 'different valid COS bucket accepted: ') + host, async () => {
        const url = 'https://' + host + '/output/image.png?signature=fixture';
        const test = harness(count => count === 1 ? result(url) : new Response(png));
        if (baseline) {
            await assert.rejects(() => test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token'), error => error.status === 502 && /域名/.test(error.message));
            assert.equal(test.requests.length, 1);
            assert.equal(test.writes.length, 0);
        } else {
            await test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token');
            assert.equal(test.requests.length, 2);
            assert.equal(test.requests[1].url, url);
            assert.equal(test.requests[1].options.headers, undefined);
            assert.equal(test.writes.length, 1);
        }
    });
}

for (const [name, url] of [
    ['arbitrary public host', 'https://images.attacker.invalid/output.png'],
    ['metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['loopback IPv4', 'https://127.0.0.1/private'],
    ['loopback IPv6', 'https://[::1]/private'],
    ['private IPv4', 'https://10.0.0.1/private'],
    ['non-HTTPS COS', 'http://' + currentHost + '/output.png'],
    ['FTP COS', 'ftp://' + currentHost + '/output.png'],
    ['alternate port', 'https://' + currentHost + ':8443/output.png'],
    ['username', 'https://user@' + currentHost + '/output.png'],
    ['username and password', 'https://user:password@' + currentHost + '/output.png'],
    ['suffix deception', 'https://' + currentHost + '.attacker.invalid/output.png'],
    ['non-COS Tencent subdomain', 'https://anything.myqcloud.com/output.png'],
    ['bucket missing appid', 'https://image-output.cos.ap-guangzhou.myqcloud.com/output.png'],
    ['internal COS endpoint', 'https://output-1250000000.cos-internal.ap-guangzhou.myqcloud.com/output.png'],
    ['accelerate endpoint outside current supported scope', 'https://generated-art-1250000000.cos.accelerate.myqcloud.com/output.png'],
    ['control characters', 'https://' + currentHost + '/output.png\n'],
]) {
    await check('reject before download: ' + name, async () => {
        const test = harness(() => result(url));
        await assert.rejects(() => test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token'), error => error.status === 502);
        assert.equal(test.requests.length, 1);
        assert.equal(test.writes.length, 0);
    });
}

for (const target of ['https://127.0.0.1/private', 'https://169.254.169.254/latest/meta-data', 'http://' + currentHost + '/plain.png', 'https://' + currentHost + '.attacker.invalid/steal']) {
    await check('reject unsafe redirect: ' + target, async () => {
        const test = harness(count => count === 1 ? result('https://' + currentHost + '/output.png') : new Response(null, { status: 302, headers: { Location: target } }));
        await assert.rejects(() => test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token'), error => error.status === 502);
        assert.equal(test.requests.length, 2);
        assert.equal(test.requests[1].options.headers, undefined);
        assert.equal(test.writes.length, 0);
    });
}

await check('relative redirect remains trusted and never carries provider authorization', async () => {
    const test = harness(count => count === 1 ? result('https://' + currentHost + '/output.png') : count === 2 ? new Response(null, { status: 302, headers: { Location: '/redirected.png?signature=fixture' } }) : new Response(png));
    await test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token');
    assert.equal(test.requests.length, 3);
    assert.ok(test.requests.slice(1).every(request => !request.options.headers));
});

await check('standard HTTPS port 443 and signed query survive URL normalization', async () => {
    const url = 'https://' + currentHost + ':443/output.png?signature=fixture%2Bvalue&expires=123';
    const test = harness(count => count === 1 ? result(url) : new Response(png));
    await test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token');
    assert.equal(test.requests[1].url, new URL(url).href);
    assert.equal(new URL(test.requests[1].url).search, new URL(url).search);
    assert.equal(test.requests[1].options.headers, undefined);
});

if (!baseline) {
    await check('redirect to another valid COS bucket is checked and accepted without Bearer', async () => {
        const target = 'https://' + otherBuckets[0] + '/redirected.png';
        const test = harness(count => count === 1 ? result('https://' + currentHost + '/output.png') : count === 2 ? new Response(null, { status: 302, headers: { Location: target } }) : new Response(png));
        await test.generateImage({ prompt: 'mock simple shape' }, 'fixture-token');
        assert.equal(test.requests.length, 3);
        assert.equal(test.requests[2].url, target);
        assert.ok(test.requests.slice(1).every(request => !request.options.headers));
    });
}

const report = { checkedAt: new Date().toISOString(), baseline, mockOnly: true, providerCalls: 0, physicalImageWrites: 0, passed: checks.every(entry => entry.passed), checks };


console.log(JSON.stringify({ baseline, passed: report.passed, checks: checks.length, failures: checks.filter(entry => !entry.passed) }));
if (!report.passed) process.exitCode = 1;
