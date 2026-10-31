import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, eventually } from './helpers/application.js';

const QUEUED_READ = "FROM chat_runs WHERE state='queued'";

/**
 * Makes the "read the queued runs" query fail like a locked SQLite file, exactly `times`
 * times, then lets it through. Everything else (auth, messages, runs) keeps working, which
 * is what a real transient `SQLITE_BUSY` looks like from the runner's point of view.
 */
function lockStorageFor(db, times) {
    const original = db.prepare.bind(db);
    let remaining = times;
    db.prepare = sql => {
        if (remaining > 0 && typeof sql === 'string' && sql.includes(QUEUED_READ)) {
            remaining -= 1;
            const failure = () => {
                const error = new Error('SQLITE_BUSY: database is locked');
                error.code = 'SQLITE_BUSY';
                throw error;
            };
            return { all: failure, get: failure, run: failure, iterate: failure };
        }
        return original(sql);
    };
    return {
        get remaining() { return remaining; },
        restore() { delete db.prepare; },
    };
}


test('five storage failures answer 503 with Retry-After, then the same request succeeds without a restart', { timeout: 30000 }, async context => {
    const f = await fixture(context, { config: { chatBreakerCooldownMs: 80 } });
    const person = f.employee('recovery_self_heal');
    const injected = lockStorageFor(f.db, 5);
    const accepted = [];
    let rejected = null;
    let rejectedBody = null;
    for (let attempt = 0; attempt < 8 && !rejected; attempt += 1) {
        const conversation = await f.conversation(person);
        const body = { conversationId: conversation.id, message: '门店这周怎么排班？', requestId: randomUUID() };
        const response = await person.call('POST', '/api/chat/runs', body);
        if (response.status === 503) { rejected = response; rejectedBody = body; }
        else {
            assert.equal(response.status, 202, JSON.stringify(response.body));
            accepted.push(response.body.run.id);
        }
    }
    assert.ok(rejected, 'the breaker must start rejecting once five reads failed');
    assert.equal(rejected.body.error.code, 'CHAT_NOT_READY');
    assert.ok(Number(rejected.headers['retry-after']) >= 1, 'Retry-After header must be present');
    assert.equal(rejected.body.retryAfterSeconds, Number(rejected.headers['retry-after']));
    assert.equal(injected.remaining, 0, 'all injected failures were consumed');

    // The breaker is open: it reports not-ready and keeps the failure code for diagnosis.
    const open = f.chat.health();
    assert.equal(open.ready, false);
    assert.equal(open.breaker.state, 'open');
    assert.ok(open.breaker.failures >= 5);
    assert.equal(open.breaker.lastError.code, 'SQLITE_BUSY');
    assert.ok(open.breaker.openUntil > Date.now() - 1000);

    // No restart, no manual intervention: the cooldown probe heals the breaker on its own.
    const retried = await eventually(async () => {
        const response = await person.call('POST', '/api/chat/runs', rejectedBody);
        return response.status === 202 ? response : null;
    }, 2000);
    assert.equal(retried.body.run.state, 'queued');
    assert.equal(f.chat.health().breaker.state, 'closed');

    // Queued work from the failed attempts survived in the same process (an in-memory
    // database would be empty after a restart), and it now drains.
    for (const id of accepted) {
        assert.ok(f.db.prepare('SELECT id FROM chat_runs WHERE id=?').get(id), 'run lost: ' + id);
    }
    await eventually(() => f.chat.health().active === 0, 8000);
    const finished = f.db.prepare("SELECT COUNT(*) AS count FROM chat_runs WHERE state='completed'").get().count;
    assert.ok(finished >= 1, 'the recovered queue must actually make progress');

    const health = await person.call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.chat.breaker.state, 'closed');
    injected.restore();
});

test('a single storage failure never opens the breaker and the next request goes straight through', { timeout: 20000 }, async context => {
    const f = await fixture(context, { config: { chatBreakerCooldownMs: 80 } });
    const person = f.employee('recovery_single_failure');
    const injected = lockStorageFor(f.db, 1);
    const conversation = await f.conversation(person);
    const first = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '先看看排班。', requestId: randomUUID() });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(injected.remaining, 0);
    // One failure is recorded but the breaker stays closed, so the endpoint keeps accepting.
    const afterFailure = f.chat.health();
    assert.equal(afterFailure.ready, true);
    assert.equal(afterFailure.breaker.state, 'closed');
    assert.equal(afterFailure.breaker.failures, 1);

    await eventually(() => f.chat.health().active === 0, 8000);
    // A fresh conversation: the first run is still sitting in the queue (its schedule
    // read failed), so reusing that conversation would legitimately return 409.
    const second = await person.call('POST', '/api/chat/runs',
        { conversationId: (await f.conversation(person)).id, message: '再看看补货。', requestId: randomUUID() });
    assert.equal(second.status, 202, JSON.stringify(second.body));
    const health = await person.call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.chat.breaker.state, 'closed');
    assert.equal(health.body.chat.breaker.failures, 0, 'a successful read clears the counter');
    injected.restore();
});

test('health keeps the last storage error code after the breaker has recovered', { timeout: 20000 }, async context => {
    const f = await fixture(context, { config: { chatBreakerCooldownMs: 80 } });
    const person = f.employee('recovery_last_error');
    const injected = lockStorageFor(f.db, 5);
    // Drive five consecutive read failures through real requests (one per conversation).
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const conversation = await f.conversation(person);
        const response = await person.call('POST', '/api/chat/runs',
            { conversationId: conversation.id, message: '第 ' + attempt + ' 次排班讨论。', requestId: randomUUID() });
        assert.equal(response.status, 202, JSON.stringify(response.body));
    }
    assert.equal(injected.remaining, 0);
    assert.equal(f.chat.health().breaker.state, 'open');
    await eventually(() => f.chat.health().ready === true, 2000);
    injected.restore();
    await eventually(() => f.chat.health().active === 0, 8000);

    const health = await person.call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.chat.breaker.state, 'closed');
    assert.equal(health.body.chat.breaker.failures, 0);
    assert.equal(health.body.chat.breaker.openUntil, null);
    assert.equal(health.body.chat.breaker.lastError.code, 'SQLITE_BUSY');
    assert.equal(typeof health.body.chat.breaker.lastError.at, 'number');
    assert.ok(health.body.chat.ready);
    assert.equal(health.body.chat.active, 0);
});
