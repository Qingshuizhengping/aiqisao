import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { openDatabase } from '../lib/database.js';
import { publicUser } from '../lib/access.js';
import { createMemoryService } from '../lib/memory.js';
import { insertMemory, vectorBuffer } from '../lib/memory-store.js';

function gate() {
    let resolve;
    let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    return { promise, resolve, reject };
}

async function until(check, message = 'Memory work did not settle') {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

async function fixture(context, { extract, embed, filePath = ':memory:' } = {}) {
    let db = openDatabase(filePath);
    const users = {};
    for (const username of ['alice', 'bob', 'manager', 'outsider', 'system']) {
        const id = randomUUID();
        db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,mfa_secret,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(id, username, username, 'fixture-only', username === 'system' ? 'admin' : 'member',
                ['manager', 'outsider', 'system'].includes(username) ? 'fixture-enrolled' : null, Date.now(), Date.now());
        users[username] = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id), db);
    }
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    for (const [id, name] of [[projectId, 'Launch A'], [otherProjectId, 'Private B']]) {
        db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
            .run(id, name, users.manager.id, Date.now(), Date.now());
    }
    for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['manager', 'admin']]) {
        db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)')
            .run(projectId, users[name].id, role, Date.now());
    }
    db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(otherProjectId, users.outsider.id, 'admin', Date.now());
    const calls = { extract: [], embed: [] };
    const provider = {
        async extractMemory(input, options) {
            calls.extract.push(input);
            return extract ? extract(input, options) : { memories: [] };
        },
        async embed(texts, options) {
            calls.embed.push(texts);
            return embed ? embed(texts, options) : texts.map(text => /简洁|风格|表达/.test(text) ? [1, 0, 0] : /预算|budget/.test(text) ? [0, 1, 0] : [0, 0, 1]);
        },
    };
    const config = { embeddingModel: 'fixture-embedding' };
    let service = createMemoryService({ db, config, provider });
    const application = express();
    application.use(express.json());
    application.use((request, response, next) => {
        const name = request.headers['x-fixture-user'] || 'alice';
        request.user = users[name];
        next();
    });
    application.use('/api', (request, response, next) => service.router(request, response, next));
    application.use((error, request, response, next) => {
        response.status(error.status || 500).json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : 'Internal fixture error' } });
    });
    const server = application.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    context.after(async () => {
        await service.stop();
        await new Promise(resolve => server.close(resolve));
        db.close();
    });
    async function request(name, url, method = 'GET', body) {
        return new Promise((resolve, reject) => {
            const outgoing = httpRequest(base + '/api' + url, { method,
                headers: { 'Content-Type': 'application/json', 'x-fixture-user': name } }, response => {
                let data = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { data += chunk; });
                response.on('end', () => {
                    try { resolve({ status: response.statusCode, body: JSON.parse(data) }); } catch (error) { reject(error); }
                });
            });
            outgoing.on('error', reject);
            outgoing.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    function turn({ name = 'alice', project = null, message = '我喜欢简洁的表达', answer = '好的，我会保持简洁。', conversationId } = {}) {
        const now = Date.now();
        if (!conversationId) {
            conversationId = randomUUID();
            db.prepare('INSERT INTO conversations(id,user_id,project_id,created_at,updated_at) VALUES(?,?,?,?,?)')
                .run(conversationId, users[name].id, project, now, now);
        }
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        for (const [id, role, content, created] of [[userMessageId, 'user', message, now], [assistantMessageId, 'assistant', answer, now + 1]]) {
            db.prepare('INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
                .run(id, conversationId, role, content, 'complete', created, created);
        }
        return { userId: users[name].id, conversationId, userMessageId, assistantMessageId };
    }
    async function flush() {
        service.start();
        await until(() => !db.prepare(`SELECT 1 FROM memory_jobs WHERE state IN ('queued','running')
            UNION ALL SELECT 1 FROM memory_index_jobs WHERE state IN ('queued','running') LIMIT 1`).get());
    }
    return { get db() { return db; }, users, projectId, otherProjectId, calls, provider, config, request, turn, flush,
        get service() { return service; },
        async restart() { await service.stop(); service = createMemoryService({ db, config, provider }); service.start(); },
        async reopen() { await service.stop(); db.close(); db = openDatabase(filePath); service = createMemoryService({ db, config, provider }); service.start(); },
    };
}

test('normal memory APIs keep private libraries isolated even from project and system admins', async context => {
    const page = await fixture(context);
    const personal = await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '喜欢简洁的表达' });
    assert.equal(personal.status, 201);
    const privateProject = await page.request('alice', '/memories', 'POST', { scope: 'project_private', projectId: page.projectId, content: '我的项目备忘' });
    assert.equal(privateProject.status, 201);
    for (const name of ['bob', 'manager', 'system']) {
        assert.deepEqual((await page.request(name, '/memories?scope=personal')).body.memories, []);
        for (const method of ['PATCH', 'DELETE']) {
            assert.equal((await page.request(name, '/memories/' + personal.body.memory.id, method,
                method === 'PATCH' ? { content: 'unallowed' } : undefined)).status, 404);
        }
        if (name !== 'system') assert.deepEqual((await page.request(name, '/memories?scope=project_private&projectId=' + page.projectId)).body.memories, []);
    }
    assert.equal((await page.request('system', '/memories?scope=project_private&projectId=' + page.projectId)).status, 403);
    assert.equal((await page.request('manager', '/memories/' + privateProject.body.memory.id, 'DELETE')).status, 404);
});

test('project candidates are visible to author and project admin until reviewed, without leaking source chats', async context => {
    const page = await fixture(context);
    const candidate = await page.request('alice', '/memories', 'POST', { scope: 'project_shared', projectId: page.projectId, content: '项目统一用橄榄绿' });
    const id = candidate.body.memory.id;
    assert.equal(candidate.body.memory.status, 'candidate');
    assert.equal(candidate.body.memory.canWithdraw, true);
    assert.equal(candidate.body.memory.canEdit, false);
    assert.deepEqual((await page.request('bob', '/memories?scope=project_shared&projectId=' + page.projectId)).body.memories, []);
    const review = await page.request('manager', '/memories/' + id + '/review', 'POST', { decision: 'approve' });
    assert.equal(review.body.memory.status, 'active');
    assert.equal((await page.request('bob', '/memories/' + id, 'PATCH', { content: 'not allowed' })).status, 403);
    assert.equal((await page.request('alice', '/memories/' + id, 'DELETE')).status, 403);
    const source = page.turn({ project: page.projectId });
    const shared = insertMemory(page.db, { userId: page.users.alice.id, projectId: page.projectId, scope: 'project_shared',
        content: '已确认的项目事实', status: 'active', sourceConversationId: source.conversationId, sourceMessageId: source.userMessageId });
    const ordinary = (await page.request('bob', '/memories?scope=project_shared&projectId=' + page.projectId)).body.memories.find(row => row.id === shared.id);
    const manager = (await page.request('manager', '/memories?scope=project_shared&projectId=' + page.projectId)).body.memories.find(row => row.id === shared.id);
    assert.equal(ordinary.sourceConversationId, null);
    assert.equal(manager.sourceConversationId, source.conversationId);
});

test('candidate authors may withdraw but cannot approve, while archived projects are read-only', async context => {
    const page = await fixture(context);
    const first = (await page.request('alice', '/memories', 'POST', { scope: 'project_shared', projectId: page.projectId, content: '待确认规则' })).body.memory;
    assert.equal((await page.request('alice', '/memories/' + first.id + '/review', 'POST', { decision: 'approve' })).status, 403);
    assert.equal((await page.request('alice', '/memories/' + first.id, 'DELETE')).status, 200);
    const second = (await page.request('manager', '/memories', 'POST', { scope: 'project_shared', projectId: page.projectId, content: '正式项目规则' })).body.memory;
    page.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(page.projectId);
    assert.equal((await page.request('manager', '/memories/' + second.id, 'PATCH', { active: false })).status, 409);
    assert.equal((await page.request('manager', '/memories/' + second.id + '/reindex', 'POST')).status, 409);
    assert.equal((await page.request('manager', '/memories', 'POST', { scope: 'project_private', projectId: page.projectId, content: '拒绝新增' })).status, 409);
    assert.equal((await page.request('bob', '/memories?scope=project_shared&projectId=' + page.projectId)).body.memories.length, 1);
});

test('extraction is asynchronous, idempotent per completed answer and indexes successful private memories', async context => {
    const page = await fixture(context, { extract: input => ({ memories: [{ scope: 'personal', content: '喜欢简洁的表达', key: 'writing-style', evidence: input.userMessage }] }) });
    const source = page.turn();
    const first = page.service.enqueueTurn(source);
    const again = page.service.enqueueTurn(source);
    assert.equal(first.id, again.id);
    assert.equal(page.calls.extract.length, 0);
    await page.flush();
    assert.equal(page.calls.extract.length, 1);
    assert.equal(page.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 1);
    const memory = page.db.prepare('SELECT * FROM memories').get();
    assert.equal(memory.status, 'active');
    assert.equal(memory.source_message_id, source.userMessageId);
    assert.equal(memory.source_evidence, '我喜欢简洁的表达');
    assert.equal(memory.embedding_model, 'fixture-embedding');
    assert.equal(memory.embedding_dimension, 3);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs').get().state, 'completed');
});

test('project extraction cannot promote project facts to global private memory or see other pending candidates', async context => {
    const page = await fixture(context, { extract: input => ({ memories: [{ scope: 'personal', content: '活动预算二十万', key: 'budget', evidence: input.userMessage }] }) });
    insertMemory(page.db, { scope: 'project_shared', userId: page.users.bob.id, projectId: page.projectId, content: 'Bob未公开的候选', status: 'candidate' });
    const source = page.turn({ project: page.projectId, message: '这个项目预算二十万' });
    page.service.enqueueTurn(source);
    await page.flush();
    assert.deepEqual(page.calls.extract[0].allowedScopes, ['project_private', 'project_shared']);
    assert.deepEqual(page.calls.extract[0].existingMemories, []);
    assert.equal(page.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE scope='personal'`).get().count, 0);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs').get().state, 'failed');
});

test('retrieval supports paraphrases but scopes every result before provider use and rechecks revocation', async context => {
    const page = await fixture(context);
    const own = insertMemory(page.db, { scope: 'personal', userId: page.users.alice.id, content: '喜欢简洁的表达', status: 'active' });
    const hidden = insertMemory(page.db, { scope: 'personal', userId: page.users.bob.id, content: 'Bob个人偏好', status: 'active' });
    const approved = insertMemory(page.db, { scope: 'project_shared', userId: page.users.manager.id, projectId: page.projectId, content: '项目预算已定', status: 'active' });
    insertMemory(page.db, { scope: 'project_shared', userId: page.users.bob.id, projectId: page.projectId, content: '未确认预算', status: 'candidate' });
    for (const memory of [own, hidden, approved]) page.db.prepare('UPDATE memories SET embedding=?,embedding_model=?,embedding_dimension=3 WHERE id=?')
        .run(vectorBuffer(memory.id === own.id ? [1, 0, 0] : [0, 1, 0]), 'fixture-embedding', memory.id);
    const found = await page.service.retrieve({ user: page.users.alice, projectId: page.projectId, query: '以后回答用什么风格？' });
    assert.equal(found.memories[0].id, own.id);
    assert.equal(found.memories.some(row => row.id === hidden.id), false);
    assert.equal(page.calls.embed.flat().some(text => text.includes('Bob')), false);
    await assert.rejects(page.service.retrieve({ user: page.users.system, projectId: page.projectId, query: '预算' }), error => error.status === 403);
    page.db.prepare('DELETE FROM project_members WHERE user_id=? AND project_id=?').run(page.users.alice.id, page.projectId);
    await assert.rejects(page.service.retrieve({ user: page.users.alice, projectId: page.projectId, query: '预算' }), error => error.status === 403);
});

test('retrieval rechecks membership revoked while embedding is pending', async context => {
    const pending = gate();
    const entered = gate();
    const page = await fixture(context, { embed: async () => { entered.resolve(); await pending.promise; return [[1, 0, 0]]; } });
    const memory = insertMemory(page.db, { scope: 'project_private', userId: page.users.alice.id, projectId: page.projectId, content: '我的预算说明', status: 'active' });
    const retrieving = page.service.retrieve({ user: page.users.alice, projectId: page.projectId, query: '预算' });
    await entered.promise;
    page.db.prepare('DELETE FROM project_members WHERE user_id=? AND project_id=?').run(page.users.alice.id, page.projectId);
    pending.resolve();
    await assert.rejects(retrieving, error => error.status === 403);
    assert.equal(page.db.prepare('SELECT id FROM memories WHERE id=?').get(memory.id).id, memory.id);
});

test('embedding failure degrades to keyword retrieval and an explicit index retry recovers without another chat', async context => {
    let failing = true;
    const page = await fixture(context, { embed: async texts => {
        if (failing) throw new Error('Provider private diagnostic');
        return texts.map(() => [1, 0, 0]);
    } });
    const created = (await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '喜欢简洁的表达' })).body.memory;
    await page.flush();
    const found = await page.service.retrieve({ user: page.users.alice, query: '简洁' });
    assert.equal(found.degraded, true);
    assert.equal(found.memories[0].id, created.id);
    assert.equal(found.warning.includes('Provider private diagnostic'), false);
    const calls = page.calls.embed.length;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(page.calls.embed.length, calls);
    failing = false;
    assert.equal((await page.request('alice', '/memories/' + created.id + '/reindex', 'POST')).status, 200);
    await page.flush();
    assert.equal(page.db.prepare('SELECT state FROM memory_index_jobs').get().state, 'completed');
    assert.equal(page.calls.extract.length, 0);
});

test('disabled conversations, disabled users, removed memberships and deleted sources prevent extraction', async context => {
    const page = await fixture(context);
    const disabled = page.turn();
    page.db.prepare('UPDATE conversations SET memory_enabled=0 WHERE id=?').run(disabled.conversationId);
    assert.equal(page.service.enqueueTurn(disabled), null);
    const old = page.turn({ project: page.projectId });
    page.service.enqueueTurn(old);
    page.db.prepare('DELETE FROM project_members WHERE user_id=? AND project_id=?').run(page.users.alice.id, page.projectId);
    await page.flush();
    assert.equal(page.calls.extract.length, 0);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs').get().state, 'skipped');
    const deleted = page.turn();
    page.service.enqueueTurn(deleted);
    page.db.prepare('UPDATE conversations SET deleted_at=? WHERE id=?').run(Date.now(), deleted.conversationId);
    await page.flush();
    assert.equal(page.calls.extract.length, 0);
    assert.equal((await page.request('alice', '/memory/jobs/' + page.db.prepare('SELECT id FROM memory_jobs WHERE conversation_id=?').get(deleted.conversationId).id + '/retry', 'POST')).status, 409);
    const personal = page.turn();
    page.db.prepare('UPDATE users SET auto_memory_enabled=0 WHERE id=?').run(page.users.alice.id);
    assert.equal(page.service.enqueueTurn(personal), null);
});

test('turning memory off and on while extraction runs invalidates its original control revision', async context => {
    const pending = gate();
    const entered = gate();
    const page = await fixture(context, { extract: async input => { entered.resolve(); await pending.promise; return { memories: [{ scope: 'personal', content: '喜欢简洁的表达', evidence: input.userMessage }] }; } });
    const source = page.turn();
    page.service.enqueueTurn(source);
    page.service.start();
    await entered.promise;
    page.db.prepare('UPDATE conversations SET memory_enabled=0 WHERE id=?').run(source.conversationId);
    page.db.prepare('UPDATE conversations SET memory_enabled=1 WHERE id=?').run(source.conversationId);
    pending.resolve();
    await page.flush();
    assert.equal(page.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs').get().state, 'skipped');
});

test('deletion cannot be undone by an older in-flight extraction or a repeated future proposal', async context => {
    const pending = gate();
    const entered = gate();
    const page = await fixture(context, { extract: async input => { entered.resolve(); await pending.promise; return { memories: [{ scope: 'personal', content: '喜欢简洁的表达', key: 'writing-style', evidence: input.userMessage }] }; } });
    const created = (await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '喜欢简洁的表达' })).body.memory;
    page.service.enqueueTurn(page.turn());
    page.service.start();
    await entered.promise;
    assert.equal((await page.request('alice', '/memories/' + created.id, 'DELETE')).status, 200);
    pending.resolve();
    await page.flush();
    const row = page.db.prepare('SELECT * FROM memories WHERE id=?').get(created.id);
    assert.equal(row.status, 'deleted');
    assert.equal(row.content, '');
    assert.equal(row.embedding, null);
    assert.equal(page.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 1);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs').get().state, 'skipped');
    const later = page.turn();
    page.service.enqueueTurn(later);
    await page.flush();
    assert.equal(page.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE status='active'`).get().count, 0);
});

test('conflicts require review and cannot silently overwrite an established fact', async context => {
    let content = '喜欢简洁的表达';
    const page = await fixture(context, { extract: input => ({ memories: [{ scope: 'personal', content, key: 'writing-style', evidence: input.userMessage }] }) });
    page.service.enqueueTurn(page.turn());
    await page.flush();
    content = '偏好详细的表达';
    page.service.enqueueTurn(page.turn({ message: '我的偏好调整为详细表达' }));
    await page.flush();
    const rows = page.db.prepare('SELECT * FROM memories ORDER BY created_at').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[1].status, 'conflict');
    assert.equal((await page.request('alice', '/memories/' + rows[1].id, 'PATCH', { active: true })).status, 409);
    assert.equal((await page.request('alice', '/memories/' + rows[1].id + '/review', 'POST', { decision: 'approve' })).status, 200);
    assert.equal(page.db.prepare('SELECT status FROM memories WHERE id=?').get(rows[0].id).status, 'inactive');
    assert.equal(page.db.prepare('SELECT status FROM memories WHERE id=?').get(rows[1].id).status, 'active');
});

test('invalid extraction batches are atomic and source credentials never reach an extraction provider', async context => {
    const page = await fixture(context, { extract: input => ({ memories: [
        { scope: 'personal', content: '喜欢简洁的表达', evidence: input.userMessage }, { scope: 'personal', content: 'password: unsafe-fixture-value', evidence: input.userMessage },
    ] }) });
    const secret = page.turn({ message: 'api_key: sk-fixture-only-0123456789abcdef' });
    assert.equal(page.service.enqueueTurn(secret), null);
    page.service.enqueueTurn(page.turn());
    await page.flush();
    assert.equal(page.calls.extract.length, 1);
    assert.equal(page.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
    const job = page.db.prepare('SELECT * FROM memory_jobs').get();
    assert.equal(job.state, 'failed');
    assert.equal(job.error_code, 'MEMORY_EXTRACTION_FAILED');
});

test('queued jobs resume on startup while previously running jobs require explicit retry', async context => {
    const page = await fixture(context);
    const queued = page.service.enqueueTurn(page.turn());
    const interrupted = page.service.enqueueTurn(page.turn());
    page.db.prepare(`UPDATE memory_jobs SET state='running',attempts=1 WHERE id=?`).run(interrupted.id);
    await page.restart();
    await page.flush();
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(queued.id).state, 'completed');
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(interrupted.id).state, 'interrupted');
    assert.equal(page.calls.extract.length, 1);
    assert.equal((await page.request('bob', '/memory/jobs/' + interrupted.id + '/retry', 'POST')).status, 404);
    assert.equal((await page.request('alice', '/memory/jobs/' + interrupted.id + '/retry', 'POST')).status, 200);
    await page.flush();
    assert.equal(page.calls.extract.length, 2);
    assert.equal(page.db.prepare('SELECT attempts FROM memory_jobs WHERE id=?').get(interrupted.id).attempts, 2);
});

test('automatic-memory switches stop extraction while existing active memory remains retrievable', async context => {
    const page = await fixture(context);
    const memory = insertMemory(page.db, { scope: 'personal', userId: page.users.alice.id, content: '喜欢简洁的表达', status: 'active' });
    page.db.prepare('UPDATE memories SET embedding=?,embedding_model=?,embedding_dimension=3 WHERE id=?')
        .run(vectorBuffer([1, 0, 0]), 'fixture-embedding', memory.id);
    const source = page.turn();
    page.db.prepare('UPDATE conversations SET memory_enabled=0 WHERE id=?').run(source.conversationId);
    page.db.prepare('UPDATE users SET auto_memory_enabled=0 WHERE id=?').run(page.users.alice.id);
    assert.equal(page.service.enqueueTurn(source), null);
    const result = await page.service.retrieve({ user: page.users.alice, query: '回答表达风格' });
    assert.equal(result.memories[0].id, memory.id);
    assert.equal(page.calls.extract.length, 0);
});

test('new project administrator MFA requirements apply to stale actors, retrieval and queued extraction', async context => {
    const page = await fixture(context);
    const memory = insertMemory(page.db, { scope: 'personal', userId: page.users.alice.id, content: '喜欢简洁的表达', status: 'active' });
    const source = page.turn();
    const job = page.service.enqueueTurn(source);
    page.db.prepare("UPDATE project_members SET role='admin' WHERE project_id=? AND user_id=?").run(page.projectId, page.users.alice.id);
    await assert.rejects(page.service.retrieve({ user: page.users.alice, query: '简洁' }), error => error.code === 'MFA_SETUP_REQUIRED');
    assert.equal((await page.request('alice', '/memories')).status, 428);
    assert.equal(page.service.enqueueTurn(page.turn()), null);
    await page.flush();
    assert.equal(page.calls.extract.length, 0);
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(job.id).state, 'skipped');
    assert.equal(page.db.prepare('SELECT status FROM memories WHERE id=?').get(memory.id).status, 'active');
    page.db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run('fixture-enrolled', page.users.alice.id);
    assert.equal((await page.request('alice', '/memories')).status, 200);
});

test('retrieval removes deleted or edited snapshots before returning from an asynchronous embedding call', async context => {
    const pending = gate();
    const entered = gate();
    const page = await fixture(context, { embed: async () => { entered.resolve(); await pending.promise; return [[1, 0, 0]]; } });
    const first = (await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '喜欢简洁的表达' })).body.memory;
    const second = (await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '第二条个人表达偏好' })).body.memory;
    const retrieving = page.service.retrieve({ user: page.users.alice, query: '表达风格' });
    await entered.promise;
    await page.request('alice', '/memories/' + first.id, 'DELETE');
    await page.request('alice', '/memories/' + second.id, 'PATCH', { content: '已经修改的偏好' });
    pending.resolve();
    assert.deepEqual((await retrieving).memories, []);
});

test('an embedding started before an edit or deletion cannot write obsolete vectors back', async context => {
    const pending = gate();
    const entered = gate();
    let held = true;
    const page = await fixture(context, { embed: async texts => {
        if (held) { entered.resolve(); await pending.promise; }
        return texts.map(text => text.includes('详细') ? [0, 1, 0] : [1, 0, 0]);
    } });
    const created = (await page.request('alice', '/memories', 'POST', { scope: 'personal', content: '喜欢简洁的表达' })).body.memory;
    page.service.start();
    await entered.promise;
    await page.request('alice', '/memories/' + created.id, 'PATCH', { content: '喜欢详细的表达' });
    held = false;
    pending.resolve();
    await page.flush();
    const row = page.db.prepare('SELECT * FROM memories WHERE id=?').get(created.id);
    assert.equal(row.version, 2);
    assert.equal(row.embedding.readFloatLE(0), 0);
    assert.equal(row.embedding.readFloatLE(4), 1);
    assert.equal(page.db.prepare('SELECT state FROM memory_index_jobs WHERE memory_version=1').get().state, 'skipped');
    assert.equal(page.db.prepare('SELECT state FROM memory_index_jobs WHERE memory_version=2').get().state, 'completed');
    await page.request('alice', '/memories/' + created.id, 'DELETE');
    assert.equal(page.db.prepare('SELECT embedding FROM memories WHERE id=?').get(created.id).embedding, null);
});

test('only exact user evidence is accepted and a malformed extraction never commits a partial batch', async context => {
    const invalid = [
        [{ scope: 'personal', content: '简洁' }],
        { memories: [{ scope: 'personal', content: '简洁' }] },
        { memories: [{ scope: 'personal', content: '简洁', evidence: '好的，我会保持简洁。' }] },
        { memories: [{ scope: 'personal', content: '简洁', evidence: '不存在的用户原文' }] },
        { memories: [{ scope: 'personal', content: '简洁', evidence: '我喜欢简洁的表达', extra: true }] },
        { memories: [{ scope: 'personal', content: '简洁', evidence: '我喜欢简洁的表达' }, { scope: 'personal', content: '没有证据' }] },
    ];
    let result;
    const page = await fixture(context, { extract: () => result });
    for (const value of invalid) {
        result = value;
        const job = page.service.enqueueTurn(page.turn());
        await page.flush();
        assert.equal(page.db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(job.id).state, 'failed');
        assert.equal(page.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
    }
});

test('disk-backed queues and Float32 semantic indexes survive database close and reopen', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'aiqisao-memory-fixture-'));
    const base = resolve(tmpdir());
    const target = resolve(directory);
    const child = relative(base, target);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    const page = await fixture(context, { filePath: join(directory, 'internal.sqlite'),
        extract: input => ({ memories: [{ scope: 'personal', content: '喜欢简洁的表达', evidence: input.userMessage }] }) });
    const job = page.service.enqueueTurn(page.turn());
    await page.reopen();
    await page.flush();
    assert.equal(page.db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(job.id).state, 'completed');
    const memory = page.db.prepare('SELECT * FROM memories').get();
    assert.ok(Buffer.isBuffer(memory.embedding));
    assert.equal(memory.embedding.length, memory.embedding_dimension * 4);
    await page.reopen();
    const result = await page.service.retrieve({ user: page.users.alice, query: '以后回答用什么风格' });
    assert.equal(result.memories[0].id, memory.id);
    assert.equal(result.degraded, false);
    context.after(() => rm(target, { recursive: true, force: true }));
});
