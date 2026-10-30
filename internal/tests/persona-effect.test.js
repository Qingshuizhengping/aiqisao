import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../lib/provider.js';
import { createGroundedAnswerService } from '../lib/grounding-answer.js';

const user = { id: 'persona-effect-employee' };
const source = { id: 'memory:responsibility', sourceType: 'memory', sourceId: 'responsibility',
    version: 3, confirmationId: 'confirmed-responsibility', scope: 'personal', userId: user.id,
    projectId: null, title: '合成门店分工资料',
    content: '门店先明确每项工作的负责人，再把动作和交付标准拆清楚。' };
const styled = '先定职责·再落动作。谁负责、怎么交付，先拆清楚。';
const generic = '首先需要明确每项工作的负责人，然后落实具体操作和交付标准。';

// The simulated provider exercises the real request, bounded rewrite, evidence
// gate and rendering path. It is not an evaluation of a real model's tone.
function setup(options = {}) {
    const calls = { drafts: [], verifications: [], retrieve: 0 };
    const evidence = options.evidence ?? [source];
    const facts = options.facts ?? [];
    let current = true;
    const provider = createProvider({ config: { apiBase: 'https://persona-effect.invalid/v1',
        apiKey: 'fixture-only-persona-effect', chatModel: 'mock-persona-effect', providerTimeoutMs: 10000 },
    fetchImpl: async (url, request) => {
        assert.equal(url, 'https://persona-effect.invalid/v1/chat/completions');
        const body = JSON.parse(request.body);
        assert.equal(body.stream, false);
        assert.deepEqual(body.response_format, { type: 'json_object' });
        const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        const input = JSON.parse(body.messages.at(-1).content);
        let value;
        if (system.includes('你是资料核验员')) {
            calls.verifications.push(input);
            value = options.verify ? options.verify(input) : { verdicts: input.claims.map(claim =>
                ({ claimId: claim.id, supported: true, relevant: true })) };
        } else {
            calls.drafts.push(input);
            const activePersona = system.includes('你是AI七嫂·员工专属版')
                && !system.includes('你是内部资料回答编辑');
            const claim = { id: 'responsibility', kind: 'summary', text: activePersona ? styled : generic,
                evidenceIds: [input.evidence[0]?.id], quote: input.evidence[0]?.content };
            value = options.draft ? options.draft(input, claim, () => { current = false; }) : { claims: [claim] };
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
            message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
    const library = { revalidate({ evidence = [], facts = [] }) {
        return current ? { evidence, facts } : { evidence: [], facts: [] };
    } };
    const service = createGroundedAnswerService({ provider, library,
        retrieval: { async retrieve() { calls.retrieve++; return { evidence, facts, degraded: false }; } } });
    return { calls, async answer(query = '门店的工作该怎样安排？') { return service.answer({ user, query }); } };
}

function assertCitedStyle(result) {
    assert.equal(result.grounding.status, 'verified');
    assert.equal(result.text, styled + ' [1]');
    assert.equal(result.grounding.citations.length, 1);
    assert.equal(result.grounding.citations[0].id, source.id);
    assert.equal(result.grounding.citations[0].version, source.version);
    assert.equal(result.grounding.citations[0].quote, source.content);
    assert.deepEqual(result.grounding.claims[0].citationIds, [source.id]);
}

test('the final grounded answer preserves the persona wording and its unchanged confirmed source', async () => {
    const page = setup();
    assertCitedStyle(await page.answer());
    assert.equal(page.calls.drafts.length, 1);
    assert.equal(page.calls.verifications.length, 1);
    assert.equal(page.calls.verifications[0].claims[0].text, styled);
});

test('a bland draft is rewritten once before verification without replacing its evidence', async () => {
    const page = setup({ draft(input, claim) {
        return { claims: [{ ...claim, text: input.style?.personaRevision ? styled : generic }] };
    } });
    assertCitedStyle(await page.answer());
    assert.equal(page.calls.drafts.length, 2);
    const [original, revision] = page.calls.drafts;
    assert.equal(revision.style.personaRevision, true);
    assert.deepEqual(revision.evidence, original.evidence);
    assert.deepEqual(revision.facts, original.facts);
    assert.equal(page.calls.verifications.length, 1);
    assert.equal(page.calls.verifications[0].claims[0].text, styled);
    assert.doesNotMatch(JSON.stringify(page.calls.verifications), /首先需要明确/);
});

test('a model that ignores persona revision cannot create an unbounded rewrite loop', async () => {
    const page = setup({ draft(input, claim) { return { claims: [{ ...claim, text: generic }] }; } });
    const result = await page.answer();
    assert.equal(page.calls.drafts.length, 2);
    assert.equal(page.calls.drafts[1].style.personaRevision, true);
    assert.ok(page.calls.verifications.length <= 1);
    if (result.grounding.status === 'verified') assert.equal(page.calls.verifications.length, 1);
    assert.doesNotMatch(result.text, /3天|保证业绩/);
});

test('invented days and unsupported promises cannot pass merely because they sound like the persona', async () => {
    for (const [text, semantic] of [
        ['先定职责·再冲业绩，3天收入翻倍。', false],
        ['先定职责·再落动作，保证门店业绩翻倍。', true],
    ]) {
        const page = setup({ draft(input, claim) { return { claims: [{ ...claim, text }] }; },
            verify(input) { return { verdicts: input.claims.map(claim =>
                ({ claimId: claim.id, supported: false, relevant: true })) }; } });
        const result = await page.answer();
        assert.notEqual(result.grounding.status, 'verified');
        assert.doesNotMatch(result.text, /3天|收入翻倍|保证门店业绩翻倍/);
        assert.equal(result.grounding.citations.length, 0);
        if (semantic) assert.equal(page.calls.verifications.length, 1);
    }
});

test('critical numbers still come from canonical fields rather than persona examples or model prose', async () => {
    const fact = { id: 'synthetic-price', version: 2, sourceType: 'memory', sourceId: source.sourceId,
        sourceVersion: source.version, sourceConfirmationId: source.confirmationId,
        entity: '青禾精华', field: '零售价', value: '168.00', unit: '元/瓶', aliases: [],
        evidence: '青禾精华零售价168.00元/瓶。', scope: 'personal', userId: user.id, projectId: null };
    const page = setup({ facts: [fact] });
    const result = await page.answer('青禾精华零售价是多少？');
    assert.equal(result.grounding.status, 'verified');
    assert.match(result.text, /168\.00元\/瓶/);
    assert.equal(result.grounding.citations[0].factId, fact.id);
    assert.equal(result.grounding.citations[0].factVersion, fact.version);
    assert.equal(page.calls.drafts.length, 0);
    assert.equal(page.calls.verifications.length, 0);
});

test('complete policy quotations remain verbatim and never trigger a stylistic rewrite', async () => {
    const policy = { ...source, content: '员工报销规定：收到票据后7个工作日内完成审核，发票抬头须为公司全称。' };
    const page = setup({ evidence: [policy], draft(input, claim) {
        return { claims: [{ ...claim, kind: 'quote', text: policy.content }] };
    } });
    const result = await page.answer('员工报销规定是什么？');
    assert.equal(result.grounding.status, 'verified');
    assert.equal(result.text, policy.content + ' [1]');
    assert.equal(result.grounding.citations[0].quote, policy.content);
    assert.equal(page.calls.drafts.length, 1);
    assert.equal(page.calls.verifications.length, 1);
});

test('translation and code editing keep their requested form without forced Chinese persona phrasing', async () => {
    for (const [query, output] of [
        ['翻译成英文：先明确职责，再安排工作。', 'Assign responsibilities first, then arrange the work.'],
        ['整理下面代码：const total = subtotal + tax;', 'const total = subtotal + tax;'],
    ]) {
        const page = setup({ draft(input, claim) { return { claims: [{ ...claim, text: output }] }; } });
        const result = await page.answer(query);
        assert.equal(result.grounding.status, 'verified', query);
        assert.equal(result.grounding.basis, 'user_input', query);
        assert.equal(result.text, output, query);
        assert.equal(result.grounding.citations.length, 0, query);
        assert.equal(page.calls.drafts.length, 1, query);
        assert.equal(page.calls.verifications.length, 1, query);
    }
});

test('greetings and identity use the persona voice without model calls or invented founder identity', async () => {
    for (const query of ['你好', '你是谁', '介绍一下自己']) {
        const page = setup();
        const result = await page.answer(query);
        assert.equal(result.grounding.status, 'verified', query);
        assert.equal(result.grounding.basis, 'conversation', query);
        assert.match(result.text, /七嫂/, query);
        assert.match(result.text, /·|咱们|先说|拆清|手把手|别急|眼下|卡在哪|说说/, query);
        assert.doesNotMatch(result.text, /可以帮你查询已确认资料|我是薇之雨.{0,8}创始人/, query);
        assert.equal(page.calls.drafts.length, 0, query);
        assert.equal(page.calls.verifications.length, 0, query);
        assert.equal(page.calls.retrieve, 0, query);
    }
});

test('missing evidence does not call a free-answer model for the sake of persona style', async () => {
    const page = setup({ evidence: [] });
    const result = await page.answer('门店每周具体能够增长多少业绩？');
    assert.notEqual(result.grounding.status, 'verified');
    assert.equal(page.calls.drafts.length, 0);
    assert.equal(page.calls.verifications.length, 0);
});

test('source revocation during persona revision withholds the old result before verification', async () => {
    const page = setup({ draft(input, claim, revoke) {
        if (input.style?.personaRevision) revoke();
        return { claims: [{ ...claim, text: input.style?.personaRevision ? styled : generic }] };
    } });
    const result = await page.answer();
    assert.equal(page.calls.drafts.length, 2);
    assert.equal(result.grounding.status, 'unavailable');
    assert.equal(result.grounding.citations.length, 0);
    assert.equal(page.calls.verifications.length, 0);
    assert.doesNotMatch(result.text, /先定职责|谁负责/);
});

test('source revocation after the first draft prevents sending it for persona revision', async () => {
    const page = setup({ draft(input, claim, revoke) {
        revoke();
        return { claims: [{ ...claim, text: generic }] };
    } });
    const result = await page.answer();
    assert.equal(page.calls.drafts.length, 1);
    assert.equal(page.calls.verifications.length, 0);
    assert.equal(result.grounding.status, 'unavailable');
    assert.equal(result.grounding.citations.length, 0);
});
