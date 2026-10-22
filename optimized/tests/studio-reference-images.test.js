import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceCollection } from '../src/studio-reference-images.js';

const reference = name => ({ name, dataUrl: 'data:image/png;base64,' + Buffer.from(name).toString('base64') });
const prepare = async item => reference(item);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

test('reference batches append in order and reject concurrent mutation attempts', async () => {
    const collection = createReferenceCollection();
    collection.replace([reference('existing')]);
    const gate = deferred();
    const appending = collection.append(['first', 'second'], async name => {
        if (name === 'first') await gate.promise;
        return reference(name);
    });
    assert.equal(collection.reading, true);
    assert.deepEqual(await collection.append(['duplicate'], prepare), { ok: false });
    assert.deepEqual(collection.list().map(item => item.name), ['existing']);
    gate.resolve();
    assert.deepEqual(await appending, { ok: true });
    assert.deepEqual(collection.list().map(item => item.name), ['existing', 'first', 'second']);
    assert.equal(collection.reading, false);
});

test('snapshot replacement invalidates an old batch without changing the replacement', async () => {
    const collection = createReferenceCollection();
    const gate = deferred();
    const appending = collection.append(['draft'], async () => gate.promise);
    collection.replace([reference('restored')]);
    assert.equal(collection.reading, false);
    gate.resolve(reference('draft'));
    assert.deepEqual(await appending, { ok: false, stale: true });
    assert.deepEqual(collection.list(), [reference('restored')]);
});

test('an obsolete batch finally cannot clear the reading state of a newer batch', async () => {
    const collection = createReferenceCollection();
    const oldGate = deferred();
    const newGate = deferred();
    const oldBatch = collection.append(['old'], async () => oldGate.promise);
    collection.replace([reference('new snapshot')]);
    const newBatch = collection.append(['new'], async () => newGate.promise);
    oldGate.reject(new Error('obsolete file read failed'));
    assert.deepEqual(await oldBatch, { ok: false, stale: true });
    assert.equal(collection.reading, true);
    assert.deepEqual(await collection.append(['third'], prepare), { ok: false });
    assert.deepEqual(collection.list(), [reference('new snapshot')]);
    newGate.resolve(reference('new'));
    assert.deepEqual(await newBatch, { ok: true });
    assert.equal(collection.reading, false);
    assert.deepEqual(collection.list(), [reference('new snapshot'), reference('new')]);
});

test('a failed read or malformed image discards the entire batch and preserves existing references', async () => {
    for (const failure of ['read', 'format']) {
        const collection = createReferenceCollection();
        collection.replace([reference('existing')]);
        const result = await collection.append(['valid', 'invalid'], async name => {
            if (name === 'valid') return reference(name);
            if (failure === 'read') throw new Error('file read failed');
            return { name, dataUrl: 'data:image/svg+xml;base64,AAAA' };
        });
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof Error);
        assert.deepEqual(collection.list(), [reference('existing')]);
        assert.equal(collection.reading, false);
    }
});

test('reference count is checked before file preparation and size budget is transactional', async () => {
    const counted = createReferenceCollection({ maxCount: 2 });
    counted.replace([reference('existing')]);
    let prepareCalls = 0;
    const tooMany = await counted.append(['one', 'two'], async name => { prepareCalls++; return reference(name); });
    assert.equal(tooMany.ok, false);
    assert.equal(prepareCalls, 0);
    assert.deepEqual(counted.list(), [reference('existing')]);
    const first = reference('existing');
    const second = reference('new');
    const sized = createReferenceCollection({ maxChars: first.dataUrl.length + second.dataUrl.length - 1 });
    sized.replace([first]);
    const tooLarge = await sized.append(['new'], prepare);
    assert.equal(tooLarge.ok, false);
    assert.match(tooLarge.error.message, /总大小过大/);
    assert.deepEqual(sized.list(), [first]);
    assert.equal(sized.reading, false);
});

test('reference snapshots are detached and rejected replacements preserve both data and pending work', async () => {
    const collection = createReferenceCollection({ maxCount: 2 });
    const input = [reference('original')];
    collection.replace(input);
    input[0].name = 'mutated input';
    const snapshot = collection.list();
    snapshot[0].name = 'mutated output';
    assert.deepEqual(collection.list(), [reference('original')]);
    const gate = deferred();
    const pending = collection.append(['second'], async () => gate.promise);
    assert.throws(() => collection.replace([reference('one'), reference('two'), reference('three')]), /最多添加/);
    assert.equal(collection.reading, true);
    gate.resolve(reference('second'));
    assert.deepEqual(await pending, { ok: true });
    assert.deepEqual(collection.list(), [reference('original'), reference('second')]);
    assert.equal(collection.remove(-1), false);
    assert.equal(collection.remove(1), true);
    assert.deepEqual(collection.list(), [reference('original')]);
});
