import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('the release archive and remote whitelist include every runtime API dependency', async () => {
    const application = fileURLToPath(new URL('../', import.meta.url));
    const deployment = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
    const archive = deployment.match(/tar czf "\$archive"[\s\S]*?\n\s+server\.js[^\r\n]+/)[0];
    const whitelist = deployment.match(/required = \{([^\r\n]+)\}/)[1];
    const visited = new Set();
    async function inspect(filename) {
        if (visited.has(filename)) return;
        visited.add(filename);
        const source = await readFile(filename, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
            const dependency = path.resolve(path.dirname(filename), match[1]);
            const relative = path.relative(application, dependency).split(path.sep).join('/');
            if (!relative.startsWith('api/') || relative === 'api/_config.js') continue;
            assert.ok(archive.split(/\s+/).includes(relative), 'Archive omits ' + relative);
            assert.ok(whitelist.includes("'" + relative + "'"), 'Remote validation omits ' + relative);
            await inspect(dependency);
        }
    }
    await inspect(path.join(application, 'server.js'));
    assert.equal(archive.split(/\s+/).includes('api/_config.js'), false);
    assert.equal(archive.split(/\s+/).includes('.env'), false);
});

test('release staging removes missing compressed sidecars while preserving generated images and downloads', async () => {
    const deployment = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
    const script = deployment.match(/python3 - "\$stage\/incoming" "\$stage\/next" <<'PY'\r?\n([\s\S]*?)\r?\nPY/)[1];
    const root = await mkdtemp(path.join(tmpdir(), 'aiqisao-release-test-'));
    const incoming = path.join(root, 'incoming');
    const next = path.join(root, 'next');
    try {
        await mkdir(path.join(incoming, 'public/static/js'), { recursive: true });
        await mkdir(path.join(next, 'public/static/js'), { recursive: true });
        await mkdir(path.join(next, 'public/static/gen'), { recursive: true });
        await mkdir(path.join(next, 'public/downloads'), { recursive: true });
        const artifacts = ['index.html', 'image.html', 'sw.js', 'static/js/studio.js'];
        for (const artifact of artifacts) {
            await writeFile(path.join(next, 'public', artifact), 'old release');
            await writeFile(path.join(next, 'public', artifact + '.br'), 'stale brotli');
            await writeFile(path.join(next, 'public', artifact + '.gz'), gzipSync('old release'));
            await writeFile(path.join(incoming, 'public', artifact), 'new release');
            await writeFile(path.join(incoming, 'public', artifact + '.gz'), gzipSync('new release'));
        }
        await writeFile(path.join(next, 'public/static/gen/paid.png'), 'persistent image');
        await writeFile(path.join(next, 'public/downloads/app.apk'), 'persistent APK');
        const python = process.platform === 'win32' ? 'python' : 'python3';
        await execute(python, ['-c', script, incoming, next], { windowsHide: true, timeout: 10000 });
        for (const artifact of artifacts) {
            assert.equal(await readFile(path.join(next, 'public', artifact), 'utf8'), 'new release');
            await assert.rejects(access(path.join(next, 'public', artifact + '.br')), { code: 'ENOENT' });
            assert.equal(gunzipSync(await readFile(path.join(next, 'public', artifact + '.gz'))).toString(), 'new release');
        }
        assert.equal(await readFile(path.join(next, 'public/static/gen/paid.png'), 'utf8'), 'persistent image');
        assert.equal(await readFile(path.join(next, 'public/downloads/app.apk'), 'utf8'), 'persistent APK');
        await writeFile(path.join(incoming, 'public/image.html.br'), 'new brotli');
        await execute(python, ['-c', script, incoming, next], { windowsHide: true, timeout: 10000 });
        assert.equal(await readFile(path.join(next, 'public/image.html.br'), 'utf8'), 'new brotli');
    } finally {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
        assert.ok(path.basename(resolved).startsWith('aiqisao-release-test-'));
        await rm(resolved, { recursive: true, force: true });
    }
});
