import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundedAnswerService, multiplyExact } from '../lib/grounding-answer.js';
import { gate } from './helpers/application.js';

const user = { id: 'person' };
const source = { id: 'memory:source', sourceType: 'memory', sourceId: 'source', version: 1,
    confirmationId: 'confirmation', scope: 'personal', userId: user.id, projectId: null, title: '工作资料', content: '门店先检查资料，再执行工作。' };
const price = { id: 'price', version: 2, sourceType: 'memory', sourceId: 'source', sourceVersion: 1,
    sourceConfirmationId: 'confirmation', entity: '青禾精华', field: '售价', value: '168.00', unit: '元/瓶',
    aliases: ['青禾'], evidence: '青禾精华售价168.00元/瓶。', scope: 'personal', userId: user.id, projectId: null };

function setup(options = {}) {
    const calls = { draft: 0, verify: 0, retrieve: 0 }, stages = [];
    let current = true;
    const data = { evidence: [source], facts: [], degraded: false, ...options.data };
    const library = { revalidate({ evidence = [], facts = [] }) { return current ? { evidence, facts } : { evidence: [], facts: [] }; } };
    const provider = {
        async draftGrounded(input) { calls.draft++; return options.draft ? options.draft(input) : { claims: [{ id: 'c1', kind: 'summary', text: '先核对资料，再开展工作。', evidenceIds: [source.id], quote: source.content }] }; },
        async verifyGrounded(input) { calls.verify++; return options.verify ? options.verify(input) : { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) }; },
    };
    const service = createGroundedAnswerService({ provider, library, retrieval: { async retrieve(input) { calls.retrieve++; return options.retrieve ? options.retrieve(input) : data; } } });
    return { calls, stages, revoke() { current = false; }, service,
        answer(query = '门店怎样开展工作？', signal) { return service.answer({ user, query, signal, onProgress: value => stages.push(value) }); } };
}

test('confirmed critical fields are filled from immutable values and exact decimal multiplication, never model text', async () => {
    const page = setup({ data: { facts: [price] } });
    const result = await page.answer('青禾精华买3瓶多少钱？');
    assert.equal(result.grounding.status, 'verified');
    assert.match(result.text, /168\.00元\/瓶/); assert.match(result.text, /504元/);
    assert.deepEqual(page.calls, { draft: 0, verify: 0, retrieve: 1 });
    assert.equal(result.grounding.citations[0].factVersion, 2);
    assert.equal(result.grounding.citations[0].number, 1);
    assert.equal(multiplyExact('0.1', '3'), '0.3'); assert.equal(multiplyExact('100.00', '1'), '100');
    assert.equal(multiplyExact('168', '1e6'), null); assert.equal(multiplyExact('168', '1000001'), null);
});

test('ambiguous quantities and mismatched units never create an invented total, while price differences use exact arithmetic', async () => {
    for (const query of ['青禾精华1e6瓶多少钱？', '青禾精华1,000瓶多少钱？', '青禾精华三瓶多少钱？', '青禾精华2盒多少钱？', '青禾精华-3瓶多少钱？',
        '青禾精华2到3瓶多少钱？', '青禾精华−2瓶多少钱？', '青禾精华1×10²瓶多少钱？', '青禾精华约3瓶多少钱？', '青禾精华3瓶半多少钱？', '青禾精华3瓶含运费多少钱？']) {
        const result = await setup({ data: { facts: [price] } }).answer(query);
        assert.equal(result.grounding.status, 'partial', query); assert.equal(result.grounding.computations.length, 0);
    }
    const total = await setup({ data: { facts: [price] } }).answer('青禾精华３瓶多少钱？');
    assert.match(total.text, /504元/);
    const other = { ...price, id: 'price-other', entity: '青禾面霜', value: '169.10' };
    const diff = await setup({ data: { facts: [price, other] } }).answer('青禾精华和青禾面霜单价相差多少？');
    assert.equal(diff.grounding.status, 'verified'); assert.equal(diff.grounding.computations[0].value, '1.1');
    const unknownUnits = await setup({ data: { facts: [{ ...price, unit: '' }, { ...other, unit: '' }] } }).answer('青禾精华和青禾面霜价格之和');
    assert.equal(unknownUnits.grounding.status, 'partial'); assert.equal(unknownUnits.grounding.computations.length, 0);
});

test('critical questions require confirmed fact fields even when a confirmed document contains a price', async () => {
    const page = setup({ data: { evidence: [{ ...source, content: '青禾精华售价168元。' }] } });
    const result = await page.answer('青禾精华售价多少？');
    assert.equal(result.grounding.status, 'insufficient'); assert.doesNotMatch(result.text, /168/);
    assert.equal(page.calls.draft, 0);
});

test('retail arithmetic requires an explicit pricing type and no missing applicability fields', async () => {
    const retail = {...price,field:'零售价'};
    const partial = await setup({data:{facts:[retail],missingFields:['请明确价格类型']}}).answer('青禾精华3瓶多少钱？');
    assert.equal(partial.grounding.status,'partial');
    assert.equal(partial.grounding.computations.length,0);
    const explicit = await setup({data:{facts:[retail],missingFields:[]}}).answer('青禾精华零售价3瓶多少钱？');
    assert.equal(explicit.grounding.status,'verified');
    assert.equal(explicit.grounding.computations[0].value,'504');
});

test('multi-field answers retain every matched field and explicitly mark missing fields as partial', async () => {
    const specification = { ...price, id: 'size', field: '规格', value: '30', unit: 'ml', evidence: '青禾精华规格30ml。' };
    const complete = setup({ data: { facts: [price, specification], requiresFacts: true } });
    const answer = await complete.answer('青禾精华价格和规格是多少？');
    assert.equal(answer.grounding.status, 'verified'); assert.match(answer.text, /168\.00元\/瓶/); assert.match(answer.text, /30ml/);
    const partial = setup({ data: { facts: [price], requiresFacts: true, missingFields: ['规格'] } });
    const result = await partial.answer('青禾精华价格和规格是多少？');
    assert.equal(result.grounding.status, 'partial'); assert.match(result.text, /规格/); assert.match(result.text, /暂时无法确认/);
});

test('different confirmed values return both sourced records as a conflict instead of choosing a winner', async () => {
    const page = setup({ data: { facts: [price, { ...price, id: 'price2', value: '198.00', evidence: '青禾精华售价198.00元/瓶。' }] } });
    const result = await page.answer('青禾精华售价多少？');
    assert.equal(result.grounding.status, 'conflict'); assert.match(result.text, /168\.00/); assert.match(result.text, /198\.00/);
    assert.deepEqual(result.grounding.citations.map(item => item.number), [1, 2]); assert.equal(page.calls.draft, 0);
});

test('ambiguous objects ask for clarification without outputting a candidate value', async () => {
    const page = setup({ data: { ambiguous: true, facts: [price, { ...price, id: 'other', entity: '青禾面霜', value: '999' }] } });
    const result = await page.answer('青禾多少钱？');
    assert.equal(result.grounding.status, 'insufficient'); assert.match(result.text, /青禾面霜/); assert.doesNotMatch(result.text, /168|999/);
});

test('missing evidence and degraded retrieval never invoke a free answer model', async () => {
    for (const data of [{ evidence: [], facts: [] }, { degraded: true, facts: [price] }]) {
        const page = setup({ data }); const result = await page.answer();
        assert.ok(['insufficient', 'unavailable'].includes(result.grounding.status)); assert.equal(page.calls.draft, 0);
    }
    const page = setup({ retrieve() { throw new Error('PRIVATE-UPSTREAM-DIAGNOSTIC'); } });
    assert.doesNotMatch((await page.answer()).text, /PRIVATE/);
});

test('unsupported numbers, critical policy claims and invented citation IDs are withheld before semantic review', async () => {
    for (const claim of [
        { text: '售价999元。', evidenceIds: [source.id], quote: source.content },
        { text: '门店必须接受所有退款。', evidenceIds: [source.id], quote: source.content },
        { text: '可以直接执行。', evidenceIds: ['made-up'], quote: source.content },
        { text: '可以直接执行。', evidenceIds: [source.id], quote: '不是来源原文' },
    ]) {
        const page = setup({ draft: () => ({ claims: [{ id: 'c1', kind: 'summary', ...claim }] }) });
        const result = await page.answer(); assert.equal(result.grounding.status, 'insufficient'); assert.equal(page.calls.verify, 0);
        assert.doesNotMatch(result.text, /999|接受所有退款|可以直接执行/);
    }
});

test('Unicode and financial numerals cannot bypass the canonical value requirement through summaries', async () => {
    for (const text of ['产品甲为１６８元。', '产品甲为壹佰陆拾捌圓。', '产品甲为一六八。', '产品甲为١٦٨元。']) {
        const page = setup({ draft: () => ({ claims: [{ id: 'x', kind: 'summary', text, evidenceIds: [source.id], quote: source.content }] }) });
        assert.equal((await page.answer('介绍产品甲')).grounding.status, 'insufficient');
        assert.equal(page.calls.verify, 0);
    }
    const hard = setup({ data: { facts: [] } });
    assert.equal((await hard.answer('产品甲几块钱？')).grounding.status, 'insufficient'); assert.equal(hard.calls.draft, 0);
});

test('confirmed policy can be quoted as a complete original paragraph without inventing a standard field', async () => {
    const rule = { ...source, content: '退货规定：收到商品后7天内，保持未拆封且包装完好方可申请退货。' };
    const page = setup({ data: { evidence: [rule] }, draft: () => ({ claims: [{ id: 'r', kind: 'quote', text: rule.content, evidenceIds: [rule.id], quote: rule.content }] }) });
    const result = await page.answer('退货规定是什么？');
    assert.equal(result.grounding.status, 'verified'); assert.match(result.text, /保持未拆封且包装完好/); assert.match(result.text, /7天/);
    const cut = setup({ data: { evidence: [rule] }, draft: () => ({ claims: [{ id: 'r', kind: 'quote', text: '7天内', evidenceIds: [rule.id], quote: '7天内' }] }) });
    assert.equal((await cut.answer('退货规定是什么？')).grounding.status, 'insufficient');
});

test('semantic review can retain supported claims while marking the answer partial', async () => {
    const page = setup({ draft: () => ({ claims: [
        { id: 'a', kind: 'summary', text: '先检查资料。', evidenceIds: [source.id], quote: '先检查资料' },
        { id: 'b', kind: 'summary', text: '保证完成所有任务。', evidenceIds: [source.id], quote: source.content },
    ] }), verify: () => ({ verdicts: [{ claimId: 'a', supported: true, relevant: true }, { claimId: 'b', supported: false, relevant: true }] }) });
    const result = await page.answer(); assert.equal(result.grounding.status, 'partial'); assert.match(result.text, /先检查资料/);
    assert.doesNotMatch(result.text, /保证/); assert.equal(result.grounding.claims.length, 1);
});

test('verification rejects unknown, duplicate, missing and coerced verdicts', async () => {
    for (const verdicts of [[], [{ claimId: 'wrong', supported: true, relevant: true }], [{ claimId: 'c1', supported: 'true', relevant: true }]]) {
        const page = setup({ verify: () => ({ verdicts }) });
        assert.equal((await page.answer()).grounding.status, 'unavailable');
    }
});

test('revocation during drafting prevents semantic calls and old evidence from publishing', async () => {
    const entered = gate(), release = gate();
    const page = setup({ draft: async () => { entered.resolve(); await release.promise; return { claims: [{ id: 'a', kind: 'quote', text: source.content, evidenceIds: [source.id], quote: source.content }] }; } });
    const pending = page.answer(); await entered.promise; page.revoke(); release.resolve();
    const result = await pending; assert.equal(result.grounding.status, 'unavailable'); assert.equal(page.calls.verify, 0);
    assert.doesNotMatch(result.text, /门店先检查资料/);
});

test('unverified drafts stay private while review runs and are invalidated by final source changes', async () => {
    const entered = gate(), release = gate();
    const page = setup({ verify: async input => { entered.resolve(); await release.promise; return { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) }; } });
    const pending = page.answer(); await entered.promise;
    assert.deepEqual(page.stages.map(item => item.stage), ['retrieving', 'drafting', 'verifying']);
    assert.equal(JSON.stringify(page.stages).includes('先核对资料'), false);
    page.revoke(); release.resolve(); const result = await pending;
    assert.equal(result.grounding.status, 'unavailable'); assert.equal(result.grounding.citations.length, 0);
});

test('the last publish boundary can detect revocation even after an answer was verified', async () => {
    const page = setup(); const result = await page.answer(); assert.equal(result.check(), true);
    page.revoke(); assert.equal(result.check(), false);
});

test('provider diagnostics and malformed drafts cannot turn into displayed content', async () => {
    for (const draft of [() => { throw new Error('PRIVATE MODEL TRACE'); }, () => ({ claims: [], extra: 'PRIVATE' }), () => ({ claims: [{ id: 'x', kind: 'unknown', text: 'PRIVATE' }] })]) {
        const result = await setup({ draft }).answer(); assert.equal(result.grounding.status, 'unavailable'); assert.doesNotMatch(result.text, /PRIVATE/);
    }
});

test('rewrite requests use only the present user input and cannot add new numeric facts', async () => {
    const page = setup({ draft: input => ({ claims: [{ id: 'r', kind: 'summary', text: '今天请带2份资料。', evidenceIds: ['user-input'], quote: input.evidence[0].content }] }) });
    const result = await page.answer('润色：今天带2份资料。'); assert.equal(result.grounding.status, 'verified');
    assert.equal(result.grounding.basis, 'user_input'); assert.equal(result.grounding.citations.length, 0); assert.equal(page.calls.retrieve, 0);
    const invalid = setup({ draft: input => ({ claims: [{ id: 'r', kind: 'summary', text: '今天带200份资料。', evidenceIds: ['user-input'], quote: input.evidence[0].content }] }) });
    assert.equal((await invalid.answer('润色：今天带2份资料。')).grounding.status, 'insufficient');
});

test('rewriting preserves Unicode, Chinese numbers, their units and original signs without adding new quantities', async () => {
    for (const [input, output] of [['我们两天内发货。', '我们三天内发货。'], ['本周完成工作。', '本周完成１００项工作。'],
        ['本周完成工作。', '本周完成二十项工作。'], ['请带2份资料。', '请带２瓶资料。'], ['结果为一。', '结果为二。']]) {
        const page = setup({ draft: data => ({ claims: [{ id: 'r', kind: 'summary', text: output, evidenceIds: ['user-input'], quote: data.evidence[0].content }] }) });
        assert.equal((await page.answer('请润色：' + input)).grounding.status, 'insufficient', output);
    }
    const conditional = { ...price, conditions: '青禾精华售价168.00元/瓶，仅限会员。' };
    const result = await setup({ data: { facts: [conditional], unresolvedConditions: [{ id: price.id }] } }).answer('青禾精华3瓶多少钱？');
    assert.equal(result.grounding.status, 'partial'); assert.match(result.text, /仅限会员/); assert.equal(result.grounding.computations.length, 0);
});

test('greetings and credential-bearing queries never send unneeded private content to a provider', async () => {
    const page = setup(); assert.equal((await page.answer('你好！')).grounding.basis, 'conversation');
    const result = await page.answer('我的API key是 sk-' + 'fixture'.repeat(8));
    assert.equal(result.grounding.status, 'unavailable'); assert.deepEqual(page.calls, { draft: 0, verify: 0, retrieve: 0 });
});
