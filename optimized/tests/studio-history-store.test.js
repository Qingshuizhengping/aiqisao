import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioHistoryStore } from '../src/studio-history-store.js';

const HISTORY_KEY = 'qisao_studio_history';
const entryFixture = (overrides = {}) => ({ url: '/static/gen/example.png', prompt: '产品摄影', ts: 100, ...overrides });

function memoryStorage(initial = []) {
    const values = new Map(initial);
    const writes = [];
    return {
        values,
        writes,
        getItem: key => values.get(key) ?? null,
        setItem(key, value) { writes.push({ key, value }); values.set(key, String(value)); }
    };
}

test('missing history is a successful empty read, not a storage error', () => {
    const storage = memoryStorage();
    const history = createStudioHistoryStore({ storage });
    assert.deepEqual(history.load(), { ok: true, entries: [] });
    assert.equal(storage.writes.length, 0);
});

test('legacy array records and optional optimized prompts remain compatible', () => {
    const entries = [entryFixture(), entryFixture({ url: 'https://images.example.com/result.webp?signature=legacy', ts: 50,
        originalPrompt: '原始描述', optimizedPrompt: '视觉优化描述' })];
    const raw = JSON.stringify(entries);
    const storage = memoryStorage([[HISTORY_KEY, raw]]);
    assert.deepEqual(createStudioHistoryStore({ storage }).load(), { ok: true, entries });
    assert.equal(storage.getItem(HISTORY_KEY), raw);
    assert.equal(storage.writes.length, 0);
});

test('read failure is distinguished from empty history and retains the last reliable snapshot', () => {
    const entries = [entryFixture()];
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify(entries)]]);
    const history = createStudioHistoryStore({ storage });
    assert.equal(history.load().ok, true);
    storage.getItem = () => { throw new Error('access denied'); };
    for (const operation of [() => history.load(), () => history.append(entryFixture({ url: '/static/gen/new.png' })), () => history.clear()]) {
        const result = operation();
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'HISTORY_READ_FAILED');
        assert.deepEqual(result.entries, entries);
    }
    assert.equal(storage.writes.length, 0);
});

test('first read failure returns an explicit failure rather than pretending history is empty', () => {
    const history = createStudioHistoryStore({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('must not write'); } } });
    assert.deepEqual(history.load().entries, []);
    assert.equal(history.load().ok, false);
    assert.equal(history.load().error.code, 'HISTORY_READ_FAILED');
});

test('invalid JSON and non-array history never get silently overwritten by append or clear', () => {
    for (const raw of ['{broken', '', 'null', '{}', '42', '"history"']) {
        const storage = memoryStorage([[HISTORY_KEY, raw]]);
        const history = createStudioHistoryStore({ storage });
        for (const result of [history.load(), history.append(entryFixture()), history.clear()]) {
            assert.equal(result.ok, false);
            assert.equal(result.error.code, 'HISTORY_DATA_INVALID');
        }
        assert.equal(storage.getItem(HISTORY_KEY), raw);
        assert.equal(storage.writes.length, 0);
    }
});

test('corrupt stored entries preserve the previous reliable snapshot instead of partially overwriting history', () => {
    const entries = [entryFixture()];
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify(entries)]]);
    const history = createStudioHistoryStore({ storage });
    history.load();
    const corrupt = JSON.stringify([entryFixture({ url: '/static/gen/valid.png' }), { url: '/static/gen/bad.png', prompt: 99, ts: 200 }]);
    storage.values.set(HISTORY_KEY, corrupt);
    assert.deepEqual(history.load().entries, entries);
    const result = history.append(entryFixture({ url: '/static/gen/new.png' }));
    assert.equal(result.error.code, 'HISTORY_DATA_INVALID');
    assert.deepEqual(result.entries, entries);
    assert.equal(storage.getItem(HISTORY_KEY), corrupt);
    assert.equal(storage.writes.length, 0);
});

test('append rereads the latest persisted history and preserves another tab addition', () => {
    const original = entryFixture();
    const fromOtherTab = entryFixture({ url: '/static/gen/other.png', ts: 200 });
    const newest = entryFixture({ url: '/static/gen/new.png', ts: 300 });
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify([original])]]);
    const first = createStudioHistoryStore({ storage });
    const second = createStudioHistoryStore({ storage });
    first.load();
    assert.equal(second.append(fromOtherTab).ok, true);
    const result = first.append(newest);
    assert.deepEqual(result, { ok: true, entries: [newest, fromOtherTab, original] });
    assert.deepEqual(JSON.parse(storage.getItem(HISTORY_KEY)), result.entries);
});

test('append replaces the same URL, removes duplicates, and preserves insertion order', () => {
    const original = entryFixture();
    const olderDuplicate = entryFixture({ prompt: 'older duplicate', ts: 50 });
    const other = entryFixture({ url: '/static/gen/other.png', ts: 300 });
    const replacement = entryFixture({ prompt: 'new version', ts: 400 });
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify([original, olderDuplicate, other])]]);
    const result = createStudioHistoryStore({ storage }).append(replacement);
    assert.deepEqual(result, { ok: true, entries: [replacement, other] });
});

test('load and append limit history to 36 records without rewriting during read', () => {
    const entries = Array.from({ length: 40 }, (_, index) => entryFixture({ url: '/static/gen/' + index + '.png', ts: index }));
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify(entries)]]);
    const history = createStudioHistoryStore({ storage });
    assert.deepEqual(history.load().entries, entries.slice(0, 36));
    assert.equal(storage.writes.length, 0);
    const newest = entryFixture({ url: '/static/gen/new.png', ts: 100 });
    assert.deepEqual(history.append(newest).entries, [newest, ...entries.slice(0, 35)]);
    assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)).length, 36);
});

test('custom key and smaller history limit are honored', () => {
    const storage = memoryStorage();
    const history = createStudioHistoryStore({ storage, key: 'custom_history', maxEntries: 2 });
    const entries = [0, 1, 2].map(index => entryFixture({ url: '/static/gen/' + index + '.png', ts: index }));
    for (const entry of entries) assert.equal(history.append(entry).ok, true);
    assert.deepEqual(history.load().entries, [entries[2], entries[1]]);
    assert.equal(storage.getItem(HISTORY_KEY), null);
});

test('append write failure returns reliable old entries and leaves their stored representation intact', () => {
    const original = entryFixture();
    const raw = JSON.stringify([original]);
    const storage = memoryStorage([[HISTORY_KEY, raw]]);
    const history = createStudioHistoryStore({ storage });
    storage.setItem = () => { throw new Error('quota exceeded'); };
    const result = history.append(entryFixture({ url: '/static/gen/new.png' }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'HISTORY_WRITE_FAILED');
    assert.deepEqual(result.entries, [original]);
    assert.equal(storage.getItem(HISTORY_KEY), raw);
});

test('failed clear retains reliable entries rather than falsely returning an empty history', () => {
    const entries = [entryFixture()];
    const raw = JSON.stringify(entries);
    const storage = memoryStorage([[HISTORY_KEY, raw]]);
    const history = createStudioHistoryStore({ storage });
    history.load();
    storage.setItem = () => { throw new Error('storage unavailable'); };
    const result = history.clear();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'HISTORY_WRITE_FAILED');
    assert.deepEqual(result.entries, entries);
    assert.equal(storage.getItem(HISTORY_KEY), raw);
});

test('successful clear persists the existing empty-array format and updates the reliable snapshot', () => {
    const storage = memoryStorage([[HISTORY_KEY, JSON.stringify([entryFixture()])]]);
    const history = createStudioHistoryStore({ storage });
    assert.deepEqual(history.clear(), { ok: true, entries: [] });
    assert.equal(storage.getItem(HISTORY_KEY), '[]');
    storage.getItem = () => { throw new Error('read unavailable'); };
    assert.deepEqual(history.load().entries, []);
});

test('unsafe or invalid URL values are rejected without history mutation', () => {
    const invalidUrls = [null, 1, {}, '', 'javascript:alert(1)', 'data:image/png;base64,abcd', 'file:///private/image.png', '//other.example/image.png',
        'relative.png', '/\\other.example/image.png', 'https://user:password@example.com/image.png', 'https://', 'http://[broken', ' /static/gen/space.png', '/static/gen/line\nbreak.png'];
    for (const url of invalidUrls) {
        const storage = memoryStorage();
        const result = createStudioHistoryStore({ storage }).append(entryFixture({ url }));
        assert.equal(result.ok, false, String(url));
        assert.equal(result.error.code, 'HISTORY_ENTRY_INVALID');
        assert.equal(storage.writes.length, 0);
    }
});

test('root-relative and historical HTTP or HTTPS image URLs remain accepted', () => {
    for (const url of ['/static/gen/a.png', '/static/gen/图片.webp', 'http://8.134.141.217/static/gen/a.jpg', 'https://images.example.com/a.png?token=legacy#image']) {
        const history = createStudioHistoryStore({ storage: memoryStorage() });
        assert.equal(history.append(entryFixture({ url })).ok, true, url);
    }
});

test('invalid timestamp prompt and optimization fields are rejected before writing', () => {
    const invalidEntries = [null, [], {}, entryFixture({ prompt: null }), entryFixture({ prompt: {} }), entryFixture({ prompt: 'x'.repeat(4001) }),
        entryFixture({ ts: '100' }), entryFixture({ ts: -1 }), entryFixture({ ts: NaN }), entryFixture({ ts: Infinity }),
        entryFixture({ originalPrompt: 4 }), entryFixture({ optimizedPrompt: {} }), entryFixture({ optimizedPrompt: 'x'.repeat(4001) })];
    for (const entry of invalidEntries) {
        const storage = memoryStorage();
        assert.equal(createStudioHistoryStore({ storage }).append(entry).error.code, 'HISTORY_ENTRY_INVALID');
        assert.equal(storage.writes.length, 0);
    }
});

test('empty prompt and zero timestamp remain valid legacy values', () => {
    const entry = entryFixture({ prompt: '', ts: 0, originalPrompt: '', optimizedPrompt: '' });
    assert.deepEqual(createStudioHistoryStore({ storage: memoryStorage() }).append(entry), { ok: true, entries: [entry] });
});

test('returned and supplied entries cannot mutate the reliable snapshot', () => {
    const storage = memoryStorage();
    const history = createStudioHistoryStore({ storage });
    const entry = entryFixture();
    const expected = { ...entry };
    const appended = history.append(entry);
    entry.prompt = 'mutated input';
    appended.entries[0].prompt = 'mutated output';
    storage.getItem = () => { throw new Error('read failed'); };
    const failed = history.load();
    assert.deepEqual(failed.entries, [expected]);
    failed.entries[0].prompt = 'mutated failure';
    assert.deepEqual(history.load().entries, [expected]);
});

test('unexpected record fields are not copied into persisted history', () => {
    const storage = memoryStorage();
    const entry = entryFixture({ referenceImages: ['private data'], optimizationToken: 'private token' });
    const result = createStudioHistoryStore({ storage }).append(entry);
    assert.deepEqual(result.entries, [entryFixture()]);
    assert.equal(storage.getItem(HISTORY_KEY).includes('private'), false);
});

test('invalid constructor options fail immediately', () => {
    assert.throws(() => createStudioHistoryStore({ storage: {} }), TypeError);
    assert.throws(() => createStudioHistoryStore({ storage: memoryStorage(), key: '' }), TypeError);
    for (const maxEntries of [0, -1, 1.5, 37, NaN]) {
        assert.throws(() => createStudioHistoryStore({ storage: memoryStorage(), maxEntries }), RangeError);
    }
});
