import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const mode of ['standalone server', 'process-manager import entry']) test(mode + ' starts through a versioned-release symlink and opens the private database', { timeout: 12000 }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-entry-'));
    const application = fileURLToPath(new URL('../', import.meta.url));
    const link = path.join(directory, 'current');
    fs.symlinkSync(application, link, os.platform() === 'win32' ? 'junction' : 'dir');
    const reserved = http.createServer().listen(0, '127.0.0.1');
    await once(reserved, 'listening');
    const port = reserved.address().port;
    await new Promise(resolve => reserved.close(resolve));
    const args = mode === 'standalone server' ? [path.join(link, 'server.js')]
        : ['-e', 'import(' + JSON.stringify(pathToFileURL(path.join(link, 'launch.mjs')).href) + ')'];
    const child = spawn(process.execPath, args, { windowsHide: true,
        env: { ...process.env, NODE_ENV: 'development', INTERNAL_ORIGIN: 'http://127.0.0.1:' + port,
            INTERNAL_PORT: String(port), INTERNAL_DATA_DIRECTORY: path.join(directory, 'data'),
            INTERNAL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'), INTERNAL_API_KEY: '',
            INTERNAL_BOOTSTRAP_USERNAME: 'synthetic-admin', INTERNAL_BOOTSTRAP_PASSWORD: 'SyntheticOnly2026!' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    context.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
        const resolved = path.resolve(directory);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'wzy-entry-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    await Promise.race([
        new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('internal_started')) resolve(); })),
        once(child, 'exit').then(() => { throw new Error('Server exited before startup: ' + errors); }),
        new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Startup timed out: ' + errors)), 6000); timer.unref(); }),
    ]);
    assert.ok(fs.existsSync(path.join(directory, 'data/internal.sqlite')));
    const health = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, response => {
            let body = ''; response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.modelConfigured, false);
    assert.doesNotMatch(output, /SyntheticOnly2026/);
});
