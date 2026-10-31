import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSummary } from '../shared/evidence-summary.js';

const file = (id, name) => ({ fileId: id, filename: name, content: '片段内容', scope: 'personal' });
const memory = (id, content, scope = 'personal') => ({ id, content, scope });

test('file and memory sources merge into one count and one neutral badge', () => {
    const summary = evidenceSummary({
        files: [file('f1', '门店手册.txt'), file('f2', '接待流程.txt')],
        memories: [memory('m1', '门店每周要覆盖早晚高峰')],
    });
    assert.equal(summary.total, 3);
    assert.equal(summary.label, '参考 3 条资料');
    assert.deepEqual(summary.items.map(item => item.kind), ['file', 'file', 'memory']);
    assert.equal(summary.items[0].title, '门店手册.txt');
    assert.equal(summary.items[0].label, '资料');
    assert.equal(summary.items[2].label, '记忆');
    assert.equal(summary.network.count, 0);
    assert.equal(summary.network.label, '');
});

test('a pure model-knowledge answer carries no badge and no negative wording', () => {
    const summary = evidenceSummary({ memories: [], files: [], memoryDegraded: false, knowledgeDegraded: false,
        search: { status: 'disabled', count: 0, items: [] } });
    assert.equal(summary.total, 0);
    assert.equal(summary.label, '');
    assert.deepEqual(summary.items, []);
    assert.equal(summary.network.count, 0);
    // The badge layer must never editorialise that an answer has no support.
    assert.doesNotMatch(JSON.stringify(summary), /暂无依据|无法回答|依据不足|没有依据/);
});

test('network sources stay distinguishable from local sources', () => {
    const summary = evidenceSummary({
        files: [file('f1', '门店手册.txt')],
        memories: [memory('m1', '晚高峰要加人')],
        search: { status: 'ok', count: 2, items: [
            { title: '门店运营手册', url: 'https://example.com/a', snippet: 'a' },
            { title: '接待流程', url: 'https://example.com/b', snippet: 'b' },
        ] },
    });
    // Network results are counted separately: the local badge stays at 2.
    assert.equal(summary.total, 2);
    assert.equal(summary.label, '参考 2 条资料');
    assert.equal(summary.network.count, 2);
    assert.equal(summary.network.label, '来自网络 2 条');
    assert.deepEqual(summary.network.items.map(item => item.url), ['https://example.com/a', 'https://example.com/b']);
    assert.deepEqual(summary.items.slice(2).map(item => item.kind), ['network', 'network']);
    assert.equal(summary.items[2].label, '网络');
    assert.equal(summary.items[2].url, 'https://example.com/a');
    // A non-https or missing url can never become a source link.
    const unsafe = evidenceSummary({ search: { status: 'ok', items: [{ title: 'x', url: 'http://example.com/x' }, { title: 'y' }] } });
    assert.equal(unsafe.network.count, 0);
    assert.equal(unsafe.items.length, 0);
});

test('degraded flags are surfaced without inventing sources', () => {
    const summary = evidenceSummary({ files: [], memories: [], memoryDegraded: true, knowledgeDegraded: true,
        search: { status: 'degraded', count: 0, items: [{ title: '不应该出现', url: 'https://example.com/x' }] } });
    assert.deepEqual(summary.degraded, { memory: true, knowledge: true, search: true });
    assert.equal(summary.network.count, 0, 'a degraded search must not produce sources');
    assert.deepEqual(summary.items, []);
    assert.equal(summary.label, '');
    const explicit = evidenceSummary({ degraded: { memory: false, knowledge: true, search: false } });
    assert.deepEqual(explicit.degraded, { memory: false, knowledge: true, search: false });
});

test('empty and malformed metadata is safe and never mutated', () => {
    for (const metadata of [undefined, null, {}, 'nope', 42,
        { memories: 'not-an-array', files: null, search: 'nope' },
        { memories: [null], files: [{}], search: { status: 'ok', items: [null, { title: 'ok', url: 'https://example.com/ok' }] } }]) {
        const summary = evidenceSummary(metadata);
        assert.equal(typeof summary.total, 'number');
        assert.equal(typeof summary.label, 'string');
        assert.ok(Array.isArray(summary.items));
        assert.equal(typeof summary.network.count, 'number');
        assert.equal(typeof summary.degraded.memory, 'boolean');
    }
    const metadata = { files: [file('f1', '手册.txt')], memories: [], search: { status: 'ok', items: [] } };
    const before = JSON.parse(JSON.stringify(metadata));
    evidenceSummary(metadata);
    assert.deepEqual(metadata, before, 'the summary must be read-only');
    // Malformed entries still yield usable placeholders instead of throwing.
    const placeholder = evidenceSummary({ files: [{}], memories: [{ content: '   ' }] });
    assert.equal(placeholder.total, 2);
    assert.equal(placeholder.items[0].title, '资料文件');
    assert.equal(placeholder.items[1].title, '记忆');
});
