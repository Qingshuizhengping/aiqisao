import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

for (const fixture of ['jobs', 'prompt', 'references', 'downloads', 'http', 'studio', 'studio-background']) {
    test('existing ' + fixture + ' behavior remains compatible', { timeout: 30000 }, async () => {
        const filename = fileURLToPath(new URL('./fixtures/' + fixture + '-regression.mjs', import.meta.url));
        const argumentsList = fixture.startsWith('studio') ? ['--experimental-vm-modules', filename] : [filename];
        const result = await execute(process.execPath, argumentsList, { windowsHide: true, timeout: 25000 });
        const report = JSON.parse(result.stdout.trim());
        if (fixture === 'studio') {
            assert.equal(report.passed, report.checks, JSON.stringify(report));
            assert.deepEqual(report.failures, []);
        } else assert.equal(report.passed, true, JSON.stringify(report));
    });
}
