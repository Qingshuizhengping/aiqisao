import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRequests, factCandidateBody, groundingPresentation, sourceIdentity, sourceRoute, sourceVersionChanged, citationNumber, factPeriodLabel } from '../src/grounding-state.js';

function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('fact forms preserve explicit conditions and effective dates and label expired records', () => {
    const value = factCandidateBody({type:'memory', sourceId:'source', version:2}, {entity:'甲',field:'价格',value:'168',evidence:'甲价格168',conditions:'甲价格168',validFrom:'2025-01-01',validUntil:'2025-12-31'});
    assert.equal(value.conditions, '甲价格168');
    assert.equal(value.validFrom, '2025-01-01');
    assert.equal(value.validUntil, '2025-12-31');
    assert.equal(factPeriodLabel(value, '2026-10-29'), '有效期已过');
    assert.equal(factPeriodLabel(value, '2024-12-31'), '尚未生效');
    assert.match(factPeriodLabel(value, '2025-06-01'), /2025-01-01.*2025-12-31/);
    assert.equal(groundingPresentation({role:'assistant',metadata:{grounding:{status:'verified',basis:'user_input'}}}).status, '');
    assert.equal(groundingPresentation({role:'assistant',metadata:{grounding:{status:'verified',basis:'user_input'}}},{audit:true}).status, '已核对原文');
});

test('grounding progress keeps pending drafts unpublished and distinguishes verified, conflict and unavailable responses', () => {
    const pending = groundingPresentation({ role: 'assistant', status: 'generating', content: 'unverified draft', metadata: { grounding: { stage: 'verifying', status: 'pending' } } });
    assert.equal(pending.pending, true);
    assert.equal(pending.progress, '正在整理思路…');
    assert.equal(groundingPresentation({role:'assistant',metadata:{grounding:{stage:'verifying',status:'pending'}}},{audit:true}).progress,'正在核对依据…');
    assert.equal(pending.status, '');
    for (const [status, label] of [['verified', '已核验'], ['partial', '部分内容已核验'], ['insufficient', '依据不足'], ['conflict', '资料冲突'], ['unavailable', '暂时无法核实']]) {
        const message = { role: 'assistant', metadata: { grounding: { stage: 'complete', status, citations:[{id:'reference',number:1}] } } };
        const value = groundingPresentation(message);
        assert.equal(value.pending, false); assert.equal(value.status, ''); assert.deepEqual(value.citations,[]);
        const audit = groundingPresentation(message,{audit:true});
        assert.equal(audit.status,label); assert.equal(audit.citations.length,1);
    }
    assert.equal(groundingPresentation({ role: 'user', metadata: { grounding: { status: 'pending' } } }).pending, false);
    assert.deepEqual(groundingPresentation({ role: 'assistant' }).citations, []);
});

test('source links retain exact source identity and detect obsolete citation versions before treating current content as quoted evidence', () => {
    assert.deepEqual(sourceIdentity({ type: 'memory', id: 'memory:stable-id', version: 1 }), { type: 'memory', sourceId: 'stable-id' });
    assert.equal(sourceRoute({ sourceType: 'file', sourceId: 'id/with?syntax' }), '/api/grounding/sources/file/id%2Fwith%3Fsyntax');
    assert.equal(sourceIdentity({ sourceType: 'user_input', sourceId: 'anything' }), null);
    assert.equal(sourceVersionChanged({ version: 1 }, { version: 2 }), true);
    assert.equal(sourceVersionChanged({ version: 2 }, { version: 2 }), false);
    assert.equal(citationNumber({ number: 3 }, 0), 3);
    assert.equal(citationNumber({ number: 'injected' }, 0), 1);
});

test('standard fact candidates bind the exact current source version and preserve values, units and original evidence', () => {
    const source = { type: 'file', sourceId: 'source-id', version: 8, projectId: 'ignored-client-project' };
    const value = factCandidateBody(source, { entity: ' 产品甲 ', field: ' 零售价 ', value: '00168.00', unit: '元', aliases: '甲，产品甲\n甲', evidence: '产品甲零售价00168.00元。', scope: 'project_shared', projectId: 'injected' });
    assert.deepEqual(value, { sourceType: 'file', sourceId: 'source-id', sourceVersion: 8, entity: '产品甲', field: '零售价', value: '00168.00', unit: '元', aliases: ['甲', '产品甲'], evidence: '产品甲零售价00168.00元。' });
    assert.throws(() => factCandidateBody(source, { entity: '甲', field: '价', value: '168' }), /来源摘录/);
});

test('a late source or fact request cannot update a changed scope or a closed panel', async () => {
    let connected = true;
    const requests = createGroundingRequests({ isConnected: () => connected });
    const first = requests.capture(), originalSignal = requests.signal(), read = gate();
    let renders = 0;
    const completion = read.promise.then(() => { if (requests.current(first)) renders++; });
    requests.advance();
    assert.equal(originalSignal.aborted, true);
    read.resolve(); await completion;
    assert.equal(renders, 0);
    const second = requests.capture();
    connected = false;
    assert.equal(requests.current(second), false);
    requests.dispose();
    assert.equal(requests.signal().aborted, true);
    connected = true;
    assert.equal(requests.current(second), false);
});

test('source list refresh and a newly selected detail must use independent request owners', async () => {
    const list = createGroundingRequests(), detail = createGroundingRequests();
    const listLease = list.capture(), detailLease = detail.capture();
    list.advance();
    assert.equal(list.current(listLease), false);
    assert.equal(detail.current(detailLease), true);
    list.dispose();
    assert.equal(detail.current(detailLease), true);
    detail.dispose();
});
