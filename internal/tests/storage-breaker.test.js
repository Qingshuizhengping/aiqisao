import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageBreaker } from '../lib/storage-breaker.js';

// A controllable clock keeps every backoff assertion exact and instant.
function clock(start = 1000000) {
    let value = start;
    return { now: () => value, advance(ms) { value += ms; return value; } };
}

function busy() {
    const error = new Error('SQLITE_BUSY: database is locked');
    error.code = 'SQLITE_BUSY';
    return error;
}

test('five consecutive failures open the breaker and block attempts with the last error preserved', () => {
    const time = clock();
    const breaker = createStorageBreaker({ now: time.now, threshold: 5, cooldownMs: 3000 });
    for (let index = 0; index < 4; index += 1) {
        breaker.recordFailure(busy());
        assert.equal(breaker.state(), 'closed', 'must stay closed below the threshold');
        assert.equal(breaker.allow(), true);
    }
    breaker.recordFailure(busy());
    assert.equal(breaker.state(), 'open');
    assert.equal(breaker.allow(), false);
    const snapshot = breaker.snapshot();
    assert.equal(snapshot.state, 'open');
    assert.equal(snapshot.failures, 5);
    assert.equal(snapshot.openUntil, time.now() + 3000);
    assert.equal(snapshot.lastError.code, 'SQLITE_BUSY');
    assert.equal(snapshot.lastError.at, time.now());
    breaker.dispose();
});

test('reopening after another failed probe doubles the cooldown up to the ceiling', () => {
    const time = clock();
    const breaker = createStorageBreaker({ now: time.now, threshold: 1, cooldownMs: 10, maxCooldownMs: 40 });
    const windows = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
        breaker.recordFailure(busy());
        assert.equal(breaker.state(), 'open');
        windows.push(breaker.snapshot().openUntil - time.now());
        time.advance(windows.at(-1));
        assert.equal(breaker.state(), 'half-open', 'cooldown expiry moves to half-open');
    }
    assert.deepEqual(windows, [10, 20, 40, 40], 'exponential backoff with a hard ceiling');
    breaker.dispose();
});

test('half-open probe success closes the breaker and clears the counter', () => {
    const time = clock();
    const events = [];
    const breaker = createStorageBreaker({ now: time.now, threshold: 2, cooldownMs: 50,
        onOpen: () => events.push('open'), onClose: () => events.push('close') });
    breaker.recordFailure(busy());
    breaker.recordFailure(busy());
    assert.equal(breaker.state(), 'open');
    time.advance(50);
    assert.equal(breaker.state(), 'half-open');
    assert.equal(breaker.allow(), true, 'half-open lets exactly one probe through');
    breaker.recordSuccess();
    assert.equal(breaker.state(), 'closed');
    assert.equal(breaker.allow(), true);
    const snapshot = breaker.snapshot();
    assert.equal(snapshot.failures, 0);
    assert.equal(snapshot.openUntil, null);
    assert.equal(snapshot.lastError.code, 'SQLITE_BUSY', 'the last error stays visible for diagnosis');
    assert.deepEqual(events, ['open', 'close']);
    breaker.dispose();
});

test('a failed half-open probe reopens the breaker instead of leaving it half-open', () => {
    const time = clock();
    const breaker = createStorageBreaker({ now: time.now, threshold: 3, cooldownMs: 40, maxCooldownMs: 60000 });
    for (let index = 0; index < 3; index += 1) breaker.recordFailure(busy());
    const firstWindow = breaker.snapshot().openUntil - time.now();
    time.advance(firstWindow);
    assert.equal(breaker.state(), 'half-open');
    breaker.recordFailure(busy());
    assert.equal(breaker.state(), 'open');
    assert.equal(breaker.allow(), false);
    const secondWindow = breaker.snapshot().openUntil - time.now();
    assert.equal(secondWindow, firstWindow * 2, 'the retry window grows after a failed probe');
    breaker.dispose();
});

test('the snapshot is a plain value object with a stable shape', () => {
    const time = clock();
    const breaker = createStorageBreaker({ now: time.now });
    assert.deepEqual(breaker.snapshot(), { state: 'closed', failures: 0, openUntil: null, lastError: null });
    breaker.recordFailure({ code: 'SQLITE_IOERR' });
    const snapshot = breaker.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['failures', 'lastError', 'openUntil', 'state']);
    assert.deepEqual(Object.keys(snapshot.lastError).sort(), ['at', 'code']);
    assert.equal(snapshot.lastError.code, 'SQLITE_IOERR');
    // Mutating the returned object must never leak back into the breaker.
    snapshot.failures = 99;
    assert.equal(breaker.snapshot().failures, 1);
    assert.equal(breaker.state(), 'closed');
    breaker.dispose();
});

test('constant success keeps the breaker closed and never accumulates failures', () => {
    const time = clock();
    let opened = 0;
    const breaker = createStorageBreaker({ now: time.now, threshold: 2, cooldownMs: 10, onOpen: () => { opened += 1; } });
    for (let index = 0; index < 50; index += 1) {
        breaker.recordSuccess();
        time.advance(1);
        assert.equal(breaker.state(), 'closed');
        assert.equal(breaker.allow(), true);
    }
    // An occasional failure followed by a success must not escalate: any success resets.
    for (let round = 0; round < 20; round += 1) {
        breaker.recordFailure(busy());
        breaker.recordSuccess();
        assert.equal(breaker.state(), 'closed');
    }
    assert.equal(breaker.snapshot().failures, 0);
    assert.equal(opened, 0, 'onOpen must never fire while storage is healthy');
    breaker.dispose();
});
