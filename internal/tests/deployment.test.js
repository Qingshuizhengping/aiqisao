import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../lib/config.js';
import { fixture } from './helpers/application.js';

const publicOrigin = 'https://8.134.141.217:6069';

function productionConfig(origin = publicOrigin) {
    return createConfig({
        NODE_ENV: 'production',
        INTERNAL_ORIGIN: origin,
        INTERNAL_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
    });
}

test('the public HTTPS origin retains port 6069 while the application stays on loopback', () => {
    const config = productionConfig();
    assert.equal(config.origin, publicOrigin);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3001);
    assert.equal(config.secureCookies, true);
    assert.equal(config.cookieName, '__Host-wzy_internal');
});

test('production refuses plaintext origins even when the backend address is loopback', () => {
    for (const origin of [
        'http://8.134.141.217:6069',
        'http://127.0.0.1:3001',
        'http://localhost:6069',
        'http://[::1]:3001',
    ]) {
        assert.throws(() => productionConfig(origin), /HTTPS is required/);
    }
});

test('authentication requires the exact HTTPS origin and issues a secure host-only session cookie', async context => {
    const { origin, secureCookies, cookieName } = productionConfig();
    const setup = await fixture(context, { config: { origin, secureCookies, cookieName } });
    const caller = setup.employee('deployment-probe');
    const credentials = { username: setup.config.bootstrapUsername, password: setup.config.bootstrapPassword };
    const before = setup.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;

    for (const incorrectOrigin of [
        'https://8.134.141.217',
        'https://8.134.141.217:6070',
        'http://8.134.141.217:6069',
    ]) {
        const rejected = await caller.call('POST', '/api/auth/login', credentials, { Origin: incorrectOrigin });
        assert.equal(rejected.status, 403);
        assert.equal(rejected.body.error.code, 'ORIGIN_DENIED');
        assert.equal(rejected.headers['set-cookie'], undefined);
    }
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, before);

    const accepted = await caller.call('POST', '/api/auth/login', credentials, { Origin: publicOrigin });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.user.username, setup.config.bootstrapUsername);
    assert.equal(accepted.body.user.mustChangePassword, true);
    const cookies = accepted.headers['set-cookie'];
    assert.equal(cookies.length, 1);
    const cookie = cookies[0];
    assert.match(cookie, /^__Host-wzy_internal=[A-Za-z0-9_-]{43}(?:;|$)/);
    assert.match(cookie, /;\s*Path=\/(?:;|$)/i);
    assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
    assert.match(cookie, /;\s*Secure(?:;|$)/i);
    assert.match(cookie, /;\s*SameSite=Strict(?:;|$)/i);
    assert.doesNotMatch(cookie, /;\s*Domain=/i);
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(accepted.body.user.id).count, 1);
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.extraction.length, 0);
});
