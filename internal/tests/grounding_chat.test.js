import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, eventually, gate, waitOrAbort } from './helpers/application.js';

async function setup(context, options = {}) {
    const counts = { draft: 0, verify: 0 };
    const application = await fixture(context, { config: { groundingMode: 'strict', ...options.config }, provider: {
        async draftGrounded(input, args) {
            counts.draft++;
            if (options.draft) return options.draft(input, args);
            return { claims: input.evidence.map((entry, index) => ({ id: 'c' + index, kind: 'quote', text: entry.content,
                evidenceIds: [entry.id], quote: entry.content })) };
        },
        async verifyGrounded(input, args) {
            counts.verify++;
            if (options.verify) return options.verify(input, args);
            return { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) };
        }, ...options.provider,
    } });
    async function memory(person, content, extra = {}) {
        const response = await person.call('POST', '/api/memories', { scope: 'personal', content, ...extra });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.body.memory;
    }
    async function confirm(person, original) {
        const response = await person.call('POST', '/api/grounding/sources/memory/' + original.id + '/confirm', { version: original.version });
        assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.source;
    }
    async function fact(person, source, details) {
        const created = await person.call('POST', '/api/grounding/facts', { sourceType: 'memory', sourceId: source.sourceId,
            sourceVersion: source.version, evidence: source.content, ...details });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const confirmed = await person.call('POST', '/api/grounding/facts/' + created.body.fact.id + '/confirm', { version: created.body.fact.version });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); return confirmed.body.fact;
    }
    async function send(person, conversation, message) {
        const response = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message, requestId: randomUUID() });
        assert.equal(response.status, 202, JSON.stringify(response.body)); return response.body.run;
    }
    async function finished(person, run) {
        return eventually(async () => {
            const response = await person.call('GET', '/api/chat/runs/' + run.id);
            return response.status === 200 && !['queued', 'running'].includes(response.body.run.state) && response.body;
        }, 8000);
    }
    return { ...application, counts, memory, confirm, fact, send, finished };
}

test('explicit strict mode gates unconfirmed history and never turns it into an answer', async context => {
    const f = await setup(context, { config: { groundingMode: 'strict' } });
    const person = f.employee('strict_default'), conversation = await f.conversation(person);
    await f.memory(person, '青禾精华价格168元/瓶。');
    const run = await f.send(person, conversation, '青禾精华多少钱？');
    const done = await f.finished(person, run);
    assert.equal(done.run.state, 'completed'); assert.equal(done.message.metadata.grounding.status, 'insufficient');
    assert.doesNotMatch(done.message.content, /168/); assert.equal(f.calls.length, 0); assert.equal(f.counts.draft, 0);
    assert.equal((await person.call('GET', '/api/health')).body.grounding.mode, 'strict');
});

test('strict chat uses confirmed canonical fields and exact arithmetic while preserving idempotent run APIs', async context => {
    const f = await setup(context), person = f.employee('strict_price'), conversation = await f.conversation(person);
    const source = await f.confirm(person, await f.memory(person, '青禾精华售价168.00元/瓶。'));
    await f.fact(person, source, { entity: '青禾精华', field: '售价', value: '168.00', unit: '元/瓶', aliases: ['青禾'] });
    const run = await f.send(person, conversation, '青禾精华3瓶多少钱？');
    const done = await f.finished(person, run);
    assert.equal(done.message.metadata.grounding.status, 'verified'); assert.match(done.message.content, /168\.00元\/瓶/); assert.match(done.message.content, /504元/);
    assert.equal(f.counts.draft, 0); assert.equal(done.message.metadata.grounding.citations[0].number, 1);
    const repeated = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '青禾精华3瓶多少钱？', requestId: run.requestId });
    assert.equal(repeated.status, 200); assert.equal(repeated.body.run.id, run.id);
});

test('drafts never enter SQLite, snapshots or SSE before semantic review, and reconnecting returns the verified result', async context => {
    const entered = gate(), release = gate();
    const f = await setup(context, { verify: async (input, { signal }) => {
        entered.resolve(); await waitOrAbort(release.promise, signal);
        return { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) };
    } });
    const person = f.employee('strict_private_draft'), conversation = await f.conversation(person);
    const content = '门店先检查资料，再执行工作。';
    await f.confirm(person, await f.memory(person, content));
    const run = await f.send(person, conversation, '门店怎样开展工作？'); await entered.promise;
    const pending = await person.call('GET', '/api/chat/runs/' + run.id);
    assert.equal(pending.body.message.content, ''); assert.equal(pending.body.message.metadata.grounding.stage, 'verifying');
    assert.equal(f.db.prepare('SELECT content FROM messages WHERE id=?').get(run.assistantMessageId).content, '');
    let packets = '';
    const stream = await person.stream('/api/chat/runs/' + run.id + '/events', chunk => { packets += chunk; });
    await eventually(() => packets.includes('snapshot'));
    assert.doesNotMatch(packets, /门店先检查资料/);
    stream.request.destroy(); release.resolve();
    const done = await f.finished(person, run); assert.equal(done.message.metadata.grounding.status, 'verified');
    assert.match(done.message.content, /门店先检查资料/);
    let restored = '';
    const reconnect = await person.stream('/api/chat/runs/' + run.id + '/events', chunk => { restored += chunk; });
    await reconnect.ended; assert.match(restored, /event: done/); assert.match(restored, /门店先检查资料/);
});

test('revoking and reconfirming the same source during review cannot publish the old answer', async context => {
    const entered = gate(), release = gate();
    const f = await setup(context, { verify: async (input, { signal }) => {
        entered.resolve(); await waitOrAbort(release.promise, signal);
        return { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) };
    } });
    const person = f.employee('strict_reconfirm'), conversation = await f.conversation(person);
    const original = await f.memory(person, '门店先检查资料，再执行工作。'); await f.confirm(person, original);
    const run = await f.send(person, conversation, '门店怎样开展工作？'); await entered.promise;
    await person.call('POST', '/api/grounding/sources/memory/' + original.id + '/revoke', { version: original.version });
    await f.confirm(person, original); release.resolve();
    const done = await f.finished(person, run);
    assert.equal(done.message.metadata.grounding.status, 'unavailable'); assert.equal(done.message.metadata.grounding.citations.length, 0);
    assert.doesNotMatch(done.message.content, /门店先检查资料/);
});

test('explicit stop during verification retains no unverified text and does not enqueue automatic extraction', async context => {
    const entered = gate(), release = gate();
    const f = await setup(context, { verify: async (input, { signal }) => { entered.resolve(); await waitOrAbort(release.promise, signal); return { verdicts: [] }; } });
    const person = f.employee('strict_stop'), conversation = await f.conversation(person);
    await f.confirm(person, await f.memory(person, '门店先检查资料，再执行工作。'));
    const run = await f.send(person, conversation, '门店怎样开展工作？'); await entered.promise;
    const stopped = await person.call('POST', '/api/chat/runs/' + run.id + '/stop', {});
    assert.equal(stopped.status, 200); assert.equal(stopped.body.run.state, 'stopped'); assert.equal(stopped.body.message.content, '');
    release.resolve(); await eventually(() => f.chat.health().active === 0); assert.equal(f.extraction.length, 0);
});

test('project administrators receive only shared grounding metadata across conversation, snapshot and SSE reads', async context => {
    const f = await setup(context), manager = f.employee('strict_manager'), member = f.employee('strict_member');
    const project = (await manager.call('POST', '/api/projects', { name: 'Scoped grounded work' })).body.project;
    await manager.call('PUT', '/api/projects/' + project.id + '/members/' + member.id, { role: 'member' });
    const own = await f.memory(member, '私人的工作暗号是紫色雨伞。', { scope: 'project_private', projectId: project.id }); await f.confirm(member, own);
    const shared = await f.memory(manager, '门店先检查资料，再执行工作。', { scope: 'project_shared', projectId: project.id }); await f.confirm(manager, shared);
    const conversation = await f.conversation(member, project.id);
    const run = await f.send(member, conversation, '门店工作与个人工作暗号是什么？');
    const done = await f.finished(member, run);
    assert.equal(done.message.metadata.grounding.citations.length, 2);
    assert.ok(done.message.metadata.grounding.citations.some(item => item.scope === 'project_private'));
    for (const route of ['/api/conversations/' + conversation.id, '/api/chat/runs/' + run.id]) {
        const response = await manager.call('GET', route);
        const message = response.body.message || response.body.messages.find(item => item.role === 'assistant');
        assert.ok(message.metadata.grounding.citations.every(item => item.scope === 'project_shared'));
        assert.equal(JSON.stringify(message.metadata.grounding).includes('紫色雨伞'), false);
        assert.ok(message.metadata.grounding.citations.every(item => item.number >= 1));
    }
    let packets = '';
    const stream = await manager.stream('/api/chat/runs/' + run.id + '/events', chunk => { packets += chunk; }); await stream.ended;
    for (const frame of packets.split('\n\n').filter(frame => frame.includes('data:'))) {
        const payload = JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5));
        assert.equal(JSON.stringify(payload.message?.metadata?.grounding).includes('紫色雨伞'), false);
    }
});

test('changing source content during review returns an unavailable answer instead of publishing the old paragraph', async context => {
    const entered = gate(), release = gate();
    const f = await setup(context, { verify: async (input, { signal }) => { entered.resolve(); await waitOrAbort(release.promise, signal); return { verdicts: input.claims.map(claim => ({claimId:claim.id,supported:true,relevant:true})) }; } });
    const person = f.employee('strict_edit_source'), conversation = await f.conversation(person);
    const original = await f.memory(person, '门店先检查资料，再执行工作。'); await f.confirm(person, original);
    const run = await f.send(person, conversation, '门店怎样开展工作？'); await entered.promise;
    await person.call('PATCH', '/api/memories/' + original.id, { content: '门店先联系负责人，再开展工作。' }); release.resolve();
    const done = await f.finished(person, run); assert.equal(done.message.metadata.grounding.status, 'unavailable'); assert.doesNotMatch(done.message.content, /先检查资料/);
});
