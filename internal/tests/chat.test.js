import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, eventually, gate, waitOrAbort } from './helpers/application.js';

test('new discussions default to automatic memory without a per-message opt-in', async context => {
    const setup = await fixture(context);
    const person = setup.employee('default-memory');
    const conversation = await setup.conversation(person);
    assert.equal(conversation.memoryEnabled, true);
    assert.equal(setup.db.prepare('SELECT auto_memory_enabled FROM users WHERE id=?').get(person.id).auto_memory_enabled, 1);
    const created = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id,
        message: '我的工作偏好是先给结论，再列出行动步骤。', requestId: randomUUID() });
    assert.equal(created.status, 202);
    await eventually(() => setup.extraction.length === 1);
});

test('memory deleted while file retrieval is pending never reaches the model context', async context => {
    const setup = await fixture(context);
    const person = setup.employee('context-revalidation');
    const added = await person.call('POST', '/api/memories', { scope: 'personal', content: '会议备忘的暗号是紫色雨伞。' });
    const memoryRead = gate();
    const filesReady = gate();
    const original = setup.memory.retrieve;
    setup.memory.retrieve = async parameters => {
        const result = await original(parameters);
        memoryRead.resolve();
        return result;
    };
    setup.knowledge.retrieve = async () => { await filesReady.promise; return { references: [], degraded: false }; };
    const conversation = await setup.conversation(person);
    const created = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id,
        message: '会议备忘的暗号是什么？', requestId: randomUUID() });
    await memoryRead.promise;
    assert.equal((await person.call('DELETE', '/api/memories/' + added.body.memory.id)).status, 200);
    filesReady.resolve();
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(created.body.run.id).state === 'completed');
    assert.doesNotMatch(JSON.stringify(setup.calls[0]), /紫色雨伞/);
    const message = (await person.call('GET', '/api/chat/runs/' + created.body.run.id)).body.message;
    assert.equal(message.metadata.memories.length, 0);
});

test('server persists one generation per idempotency key and returns authoritative Markdown', async context => {
    const setup = await fixture(context);
    const person = setup.employee('alice');
    const conversation = await setup.conversation(person);
    const input = { conversationId: conversation.id, message: '测试流式回答', requestId: randomUUID() };
    const created = await person.call('POST', '/api/chat/runs', input);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const runId = created.body.run.id;
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(runId).state === 'completed');
    const repeated = await person.call('POST', '/api/chat/runs', input);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.run.id, runId);
    assert.equal(setup.calls.length, 1);
    const conflict = await person.call('POST', '/api/chat/runs', { ...input, message: '不同内容' });
    assert.equal(conflict.status, 409);
    const result = await person.call('GET', '/api/conversations/' + conversation.id);
    assert.equal(result.body.messages.length, 2);
    assert.equal(result.body.messages[1].content, '**测试**\n\n正常回答。');
    assert.equal(result.body.messages[1].status, 'complete');
    assert.equal(result.body.run, null);
    await eventually(() => setup.extraction.length === 1);
});

test('disconnecting SSE leaves generation running and reconnect returns the same completed result', { timeout: 12000 }, async context => {
    const release = gate();
    let count = 0;
    const setup = await fixture(context, { provider: { async *chat(messages, { signal }) {
        count++; yield '第一段'; await waitOrAbort(release.promise, signal); yield '\n\n**第二段**';
    } } });
    const person = setup.employee('alice');
    const conversation = await setup.conversation(person);
    const submitted = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '后台测试', requestId: randomUUID() });
    const id = submitted.body.run.id;
    await eventually(() => setup.db.prepare('SELECT content FROM messages WHERE id=?').get(submitted.body.run.assistantMessageId).content === '第一段');
    let first = '';
    const stream = await person.stream('/api/chat/runs/' + id + '/events', (chunk, request) => { first += chunk; request.destroy(); });
    await eventually(() => first.includes('snapshot'));
    assert.match(first, /第一段/);
    assert.equal(setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(id).state, 'running');
    release.resolve();
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(id).state === 'completed');
    let restored = '';
    const second = await person.stream('/api/chat/runs/' + id + '/events', chunk => { restored += chunk; });
    await second.ended;
    assert.match(restored, /event: done/);
    assert.match(restored, /第二段/);
    assert.equal(count, 1);
    stream.request.destroy();
});

test('explicit stop persists partial output, prevents extraction and allows a fresh request', async context => {
    const release = gate();
    const setup = await fixture(context, { provider: { async *chat(messages, { signal }) {
        yield '已收到的内容'; await waitOrAbort(release.promise, signal); yield '后续';
    } } });
    const person = setup.employee('alice');
    const conversation = await setup.conversation(person);
    const input = { conversationId: conversation.id, message: '停止测试', requestId: randomUUID() };
    const created = await person.call('POST', '/api/chat/runs', input);
    await eventually(() => setup.db.prepare('SELECT content FROM messages WHERE id=?').get(created.body.run.assistantMessageId).content);
    assert.equal((await person.call('POST', '/api/chat/runs', { ...input, requestId: randomUUID() })).status, 409);
    const stopped = await person.call('POST', '/api/chat/runs/' + created.body.run.id + '/stop', {});
    assert.equal(stopped.body.run.state, 'stopped');
    assert.equal(stopped.body.message.content, '已收到的内容');
    assert.equal(setup.extraction.length, 0);
    release.resolve();
    await eventually(() => setup.chat.health().active === 0);
    assert.equal((await person.call('POST', '/api/chat/runs', { ...input, requestId: randomUUID() })).status, 202);
});

test('project admin reads other member conversations only and system audit never expands normal access', async context => {
    const setup = await fixture(context);
    const owner = setup.employee('owner', 'admin');
    const member = setup.employee('member');
    const outsider = setup.employee('outsider');
    const auditor = setup.employee('auditor', 'admin');
    const project = (await owner.call('POST', '/api/projects', { name: '项目甲' })).body.project;
    assert.equal((await owner.call('PUT', '/api/projects/' + project.id + '/members/' + member.id, { role: 'member' })).status, 200);
    const projectChat = await setup.conversation(member, project.id);
    const privateChat = await setup.conversation(member);
    const visible = await owner.call('GET', '/api/conversations/' + projectChat.id);
    assert.equal(visible.status, 200);
    assert.equal(visible.body.conversation.readOnly, true);
    assert.equal((await owner.call('PATCH', '/api/conversations/' + projectChat.id, { title: '不允许' })).status, 403);
    assert.equal((await outsider.call('GET', '/api/conversations/' + projectChat.id)).status, 403);
    assert.equal((await owner.call('GET', '/api/conversations/' + privateChat.id)).status, 403);
    assert.equal((await auditor.call('GET', '/api/conversations/' + privateChat.id)).status, 403);
    assert.equal((await auditor.call('GET', '/api/admin/audit/conversations/' + privateChat.id)).status, 200);
    assert.equal((await auditor.call('PATCH', '/api/admin/audit/conversations/' + privateChat.id, { title: '不允许' })).status, 404);
    assert.equal((await member.call('DELETE', '/api/conversations/' + privateChat.id)).status, 200);
    assert.equal((await member.call('GET', '/api/conversations/' + privateChat.id)).status, 404);
    assert.ok((await auditor.call('GET', '/api/admin/audit/conversations/' + privateChat.id)).body.conversation.deletedAt);
    assert.equal((await owner.call('PATCH', '/api/projects/' + project.id, { archived: true })).status, 200);
    assert.equal((await member.call('POST', '/api/chat/runs', { conversationId: projectChat.id, message: '不能写', requestId: randomUUID() })).status, 409);
});

test('member removal during generation aborts upstream and immediately denies every read', async context => {
    const release = gate();
    let aborted = false;
    const setup = await fixture(context, { provider: { async *chat(messages, { signal }) {
        yield '开始'; try { await waitOrAbort(release.promise, signal); } catch (error) { aborted = true; throw error; }
    } } });
    const admin = setup.employee('project-admin', 'admin');
    const member = setup.employee('member');
    const project = (await admin.call('POST', '/api/projects', { name: '撤权项目' })).body.project;
    await admin.call('PUT', '/api/projects/' + project.id + '/members/' + member.id, { role: 'member' });
    const conversation = await setup.conversation(member, project.id);
    const created = await member.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '测试', requestId: randomUUID() });
    await eventually(() => setup.db.prepare('SELECT content FROM messages WHERE id=?').get(created.body.run.assistantMessageId).content);
    assert.equal((await admin.call('DELETE', '/api/projects/' + project.id + '/members/' + member.id)).status, 200);
    assert.equal((await member.call('GET', '/api/chat/runs/' + created.body.run.id)).status, 403);
    await eventually(() => aborted);
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(created.body.run.id).state === 'stopped');
    assert.equal(setup.extraction.length, 0);
});

test('project readers cannot obtain private library snapshots through messages or stream metadata, and reads are audited', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('project-admin', 'admin');
    const member = setup.employee('member');
    const project = (await admin.call('POST', '/api/projects', { name: '项目' })).body.project;
    await admin.call('PUT', '/api/projects/' + project.id + '/members/' + member.id, { role: 'member' });
    await member.call('POST', '/api/memories', { scope: 'personal', content: '我的工作偏好是特别简短' });
    const conversation = await setup.conversation(member, project.id);
    const created = await member.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '我的工作偏好', requestId: randomUUID() });
    const id = created.body.run.id;
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(id).state === 'completed');
    const mine = await member.call('GET', '/api/chat/runs/' + id);
    assert.ok(mine.body.message.metadata.memories.some(entry => entry.scope === 'personal'));
    const run = await admin.call('GET', '/api/chat/runs/' + id);
    assert.equal(run.body.message.metadata.memories.length, 0);
    const chat = await admin.call('GET', '/api/conversations/' + conversation.id);
    assert.equal(chat.body.messages[1].metadata.memories.length, 0);
    let frames = '';
    const stream = await admin.stream('/api/chat/runs/' + id + '/events', chunk => { frames += chunk; });
    await stream.ended;
    assert.doesNotMatch(frames, /特别简短/);
    const actions = setup.db.prepare('SELECT action FROM audit_records WHERE actor_id=?').all(admin.id).map(row => row.action);
    assert.ok(actions.includes('project.chat_run.read'));
    assert.ok(actions.includes('project.chat_run.subscribe'));
});

test('disabled extraction still retrieves active memories and never imports audit-visible private facts', async context => {
    const setup = await fixture(context);
    const person = setup.employee('alice', 'admin');
    const other = setup.employee('bob');
    const mine = await person.call('POST', '/api/memories', { scope: 'personal', content: '我的工作偏好是简短回答' });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    await other.call('POST', '/api/memories', { scope: 'personal', content: '绝密其他员工事实' });
    await person.call('PATCH', '/api/auth/preferences', { autoMemoryEnabled: false });
    const conversation = await setup.conversation(person, null, { memoryEnabled: false });
    const created = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '我的工作偏好是什么', requestId: randomUUID() });
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(created.body.run.id).state === 'completed');
    assert.match(JSON.stringify(setup.calls[0]), /简短回答/);
    assert.doesNotMatch(JSON.stringify(setup.calls[0]), /绝密其他员工/);
    assert.equal(setup.extraction.length, 0);
});

test('failed provider preserves partial answer with safe errors and does not extract memory', async context => {
    const setup = await fixture(context, { provider: { async *chat() { yield '部分内容'; throw new Error('secret upstream payload'); } } });
    const person = setup.employee('alice');
    const conversation = await setup.conversation(person);
    const created = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '测试', requestId: randomUUID() });
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(created.body.run.id).state === 'failed');
    const result = await person.call('GET', '/api/chat/runs/' + created.body.run.id);
    assert.equal(result.body.message.content, '部分内容');
    assert.equal(result.body.run.errorCode, 'MODEL_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /secret upstream/);
    assert.equal(setup.extraction.length, 0);
});

test('restart interrupts in-flight work and resumes queued work without repeating the prior request', async context => {
    const setup = await fixture(context, { start: false });
    const person = setup.employee('alice');
    const now = Date.now();
    function savedRun(state) {
        const conversationId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID(), id = randomUUID();
        setup.db.prepare('INSERT INTO conversations(id,user_id,created_at,updated_at) VALUES(?,?,?,?)').run(conversationId, person.id, now, now);
        setup.db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at,updated_at) VALUES(?,?,'user','测试',?,?)").run(userMessageId, conversationId, now, now);
        setup.db.prepare("INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,'assistant',?,'generating',?,?)").run(assistantMessageId, conversationId, state === 'running' ? '重启前内容' : '', now + 1, now + 1);
        setup.db.prepare(`INSERT INTO chat_runs(id,conversation_id,user_id,request_id,input_hash,user_message_id,assistant_message_id,state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, conversationId, person.id, randomUUID(), 'test', userMessageId, assistantMessageId, state, now, now);
        return { id, assistantMessageId };
    }
    const running = savedRun('running');
    const queued = savedRun('queued');
    await setup.startServices();
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(queued.id).state === 'completed');
    assert.equal(setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(running.id).state, 'interrupted');
    assert.equal(setup.db.prepare('SELECT content FROM messages WHERE id=?').get(running.assistantMessageId).content, '重启前内容');
    assert.equal(setup.calls.length, 1);
});
