import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionLifecycle, createLifecycleOwner } from '../src/selection-lifecycle.js';

test('selection leases preserve session/scope ownership and reject stale UI commits', () => {
    const lifecycle = createSelectionLifecycle();
    const original = lifecycle.capture({ projectId: 'A' });
    assert.ok(Object.isFrozen(original));
    lifecycle.advance('selection');
    assert.equal(lifecycle.current(original), false);
    assert.equal(lifecycle.current(original, 'scope'), true);
    assert.equal(lifecycle.current(original, 'session'), true);
    let committed = false;
    assert.equal(lifecycle.commit(original, () => { committed = true; }), false);
    assert.equal(committed, false);
    const next = lifecycle.capture();
    lifecycle.advance('scope');
    assert.equal(lifecycle.current(next, 'scope'), false);
    assert.equal(lifecycle.current(next, 'session'), true);
    lifecycle.advance('session');
    assert.equal(lifecycle.current(next, 'session'), false);
});

test('list refresh and editor selection own independent leases; closing rejects both', () => {
    const list = createLifecycleOwner();
    const editor = createLifecycleOwner();
    const selectedA = editor.capture();
    const request = list.advance();
    editor.advance();
    const selectedB = editor.capture();
    assert.equal(list.current(request), true);
    assert.equal(editor.current(selectedA), false);
    assert.equal(editor.current(selectedB), true);
    list.advance();
    assert.equal(list.current(request), false);
    assert.equal(editor.current(selectedB), true);
    list.dispose(); editor.dispose();
    assert.equal(editor.current(selectedB), false);
    assert.equal(editor.current(editor.capture()), false);
});
