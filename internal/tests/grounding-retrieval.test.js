import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../lib/database.js';
import { initializeMemorySchema, insertMemory, vectorBuffer } from '../lib/memory-store.js';
import { schema as initializeKnowledgeSchema } from '../lib/knowledge-store.js';
import { createGroundingLibrary } from '../lib/grounding-library.js';
import { createGroundingRetrieval } from '../lib/grounding-retrieval.js';
import { publicUser } from '../lib/access.js';
import { gate } from './helpers/application.js';

function setup(context, { provider, config = {} } = {}) {
    const db = openDatabase(':memory:');
    initializeMemorySchema(db); initializeKnowledgeSchema(db);
    context.after(() => db.close());
    const library = createGroundingLibrary({ db });
    const calls = [];
    provider ||= { async embed(texts) { calls.push(texts); return texts.map(() => [1, 0, 0]); } };
    const settings = { embeddingModel: 'synthetic-embed', embeddingTimeoutMs: 1000, ...config };
    const retrieval = createGroundingRetrieval({ db, library, config: settings, provider });
    function user(name, role = 'member') {
        const id = randomUUID(), now = Date.now();
        db.prepare('INSERT INTO users(id,username,display_name,password_hash,system_role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(id, name, name, 'synthetic-only-unused-hash', role, now, now);
        return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id), db);
    }
    function project(owner, members = []) {
        const id = randomUUID(), now = Date.now();
        db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, '合成检索项目', owner.id, now, now);
        for (const person of [owner, ...members]) db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)')
            .run(id, person.id, person === owner ? 'admin' : 'member', now);
        return id;
    }
    function confirm(type, id, actorId, version = 1) {
        const confirmationId = randomUUID();
        db.prepare('INSERT INTO source_confirmations(id,source_type,source_id,source_version,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?)')
            .run(confirmationId, type, id, version, actorId, Date.now());
        return confirmationId;
    }
    function memory(person, content, { scope = 'personal', projectId = null, confirmed = true, vector = [0, 1, 0] } = {}) {
        const row = insertMemory(db, { userId: person.id, scope, projectId, content, status: 'active', key: content.slice(0, 15) });
        db.prepare('UPDATE memories SET embedding=?,embedding_model=?,embedding_dimension=3 WHERE id=?')
            .run(vectorBuffer(vector), settings.embeddingModel, row.id);
        return { type: 'memory', id: row.id, version: 1, scope, projectId, userId: person.id,
            content, confirmationId: confirmed ? confirm('memory', row.id, person.id) : null };
    }
    function file(person, name, contents, { scope = 'personal', projectId = null, confirmed = true, vector = [0, 1, 0] } = {}) {
        const id = randomUUID(), now = Date.now(), content = contents.join('\n');
        db.prepare(`INSERT INTO knowledge_files(id,scope,user_id,project_id,name,extension,mime_type,size_bytes,sha256,original,
            text_content,status,processing_state,index_state,chunk_count,character_count,created_at,updated_at)
            VALUES(?,?,?,?,?,'txt','text/plain',1,'synthetic',?,?,'active','ready','ready',?,?,?,?)`)
            .run(id, scope, person.id, projectId, name, Buffer.from('synthetic source bytes'), content, contents.length, content.length, now, now);
        const chunks = contents.map((body, index) => ({ id: randomUUID(), index, content: body }));
        const insert = db.prepare('INSERT INTO knowledge_chunks(id,file_id,file_version,chunk_index,content,embedding,embedding_model,embedding_dimension) VALUES(?,?,1,?,?,?,?,3)');
        db.transaction(() => { for (const chunk of chunks) insert.run(chunk.id, id, chunk.index, chunk.content, vectorBuffer(vector), settings.embeddingModel); })();
        return { type: 'file', id, version: 1, scope, projectId, userId: person.id, content, chunks,
            confirmationId: confirmed ? confirm('file', id, person.id) : null };
    }
    function fact(person, source, { entity = '青禾修护水', field = '价格', value = '168', unit = '元', aliases = [], evidence = source.content, validFrom = null, validUntil = null, conditions = '' } = {}) {
        const id = randomUUID(), now = Date.now();
        db.prepare(`INSERT INTO standard_facts(id,scope,user_id,project_id,entity,field,value,unit,aliases,source_type,source_id,
            source_version,source_confirmation_id,evidence,status,version,confirmed_by,confirmed_at,created_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,'confirmed',1,?,?,?,?,?)`)
            .run(id, source.scope, source.userId, source.projectId, entity, field, value, unit, JSON.stringify(aliases),
                source.type, source.id, source.confirmationId, evidence, person.id, now, person.id, now, now);
        db.prepare('UPDATE standard_facts SET valid_from=?,valid_until=?,conditions=? WHERE id=?').run(validFrom, validUntil, conditions, id);
        return id;
    }
    return { db, library, retrieval, calls, user, project, memory, file, fact, confirm };
}

test('unconfirmed material is never retrieved and confirmed aliases select their original canonical fact', async context => {
    const f = setup(context), user = f.user('lookup_owner');
    f.memory(user, '青禾修护水价格为 999 元。', { confirmed: false });
    const source = f.memory(user, '青禾修护水又称小青瓶，价格为 168 元。');
    const id = f.fact(user, source, { aliases: ['小青瓶'] });
    const result = await f.retrieval.retrieve({ user, query: '小青瓶多少钱？' });
    assert.equal(result.degraded, false); assert.equal(result.ambiguous, false);
    assert.deepEqual(result.facts.map(fact => fact.id), [id]);
    assert.equal(result.facts[0].value, '168'); assert.equal(result.facts[0].unit, '元');
    assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].sourceId, source.id);
    assert.equal(result.evidence[0].confirmationId, source.confirmationId);
});

test('generic prices recall labeled retail records but require the pricing type before a final quote', async context => {
    const f = setup(context), user = f.user('retail_lookup_owner');
    const source = f.memory(user, '青禾修护水零售价168元/瓶。');
    const id = f.fact(user, source, {field:'零售价',unit:'元/瓶'});
    const generic = await f.retrieval.retrieve({user,query:'青禾修护水3瓶多少钱？'});
    assert.deepEqual(generic.facts.map(f=>f.id),[id]);
    assert.ok(generic.missingFields.some(field=>field.includes('价格类型')));
    const explicit = await f.retrieval.retrieve({user,query:'青禾修护水零售价3瓶多少钱？'});
    assert.deepEqual(explicit.facts.map(f=>f.id),[id]);
    assert.deepEqual(explicit.missingFields,[]);
});

test('specific names outrank a shorter shared alias while an alias shared by several entities requires clarification', async context => {
    const f = setup(context), user = f.user('lookup_names');
    const one = f.memory(user, '青禾修护水又称修护水或明星款，价格 168 元。');
    const two = f.memory(user, '长河修护水又称修护水或明星款，价格 288 元。');
    const first = f.fact(user, one, { aliases: ['修护水', '明星款'] });
    f.fact(user, two, { entity: '长河修护水', value: '288', aliases: ['修护水', '明星款'] });
    const specific = await f.retrieval.retrieve({ user, query: '青禾修护水多少钱？' });
    assert.equal(specific.ambiguous, false); assert.deepEqual(specific.facts.map(fact => fact.id), [first]);
    const ambiguous = await f.retrieval.retrieve({ user, query: '明星款多少钱？' });
    assert.equal(ambiguous.ambiguous, true); assert.equal(ambiguous.facts.length, 2);
    assert.ok(ambiguous.conflicts.some(conflict => conflict.type === 'ambiguous_entity'));
    const unknown = await f.retrieval.retrieve({ user, query: '别的产品价格是多少？' });
    assert.equal(unknown.ambiguous, true);
});

test('conflicting values retain every confirmed fact even when the evidence budget is smaller', async context => {
    const f = setup(context, { config: { groundingEvidenceLimit: 4 } }), user = f.user('lookup_conflicts');
    const ids = [];
    for (const value of ['1.5', '15', ...Array.from({ length: 10 }, (_, index) => String(index + 20))]) {
        const source = f.memory(user, '青禾修护水价格为 ' + value + ' 元。');
        ids.push(f.fact(user, source, { value }));
    }
    const result = await f.retrieval.retrieve({ user, query: '青禾修护水价格' });
    assert.equal(result.facts.length, ids.length); assert.ok(result.evidence.length <= 4);
    const conflict = result.conflicts.find(conflict => conflict.type === 'conflicting_values');
    assert.deepEqual(new Set(conflict.factIds), new Set(ids));
    assert.notEqual(result.facts.find(fact => fact.value === '1.5').value, result.facts.find(fact => fact.value === '15').value);
});

test('a generic price never stands in for an unconfirmed wholesale price and missing fields remain explicit', async context => {
    const f = setup(context), user = f.user('lookup_price_type');
    const source = f.memory(user, '青禾修护水价格为 168 元。');
    f.fact(user, source);
    const result = await f.retrieval.retrieve({ user, query: '青禾修护水批发价是多少？' });
    assert.deepEqual(result.facts, []); assert.ok(result.missingFields.some(field => field.endsWith('批发价')));
    const partial = await f.retrieval.retrieve({ user, query: '青禾修护水价格和用量是多少？' });
    assert.equal(partial.facts.length, 1); assert.ok(partial.missingFields.some(field => field.endsWith('用量')));
    assert.equal(partial.requiresFacts, true);
    const quotation = await f.retrieval.retrieve({ user, query: '青禾修护水报价' });
    assert.equal(quotation.requiresFacts, true); assert.equal(quotation.facts[0].value, '168');
    const dose = f.memory(user, '青禾修护水每次用量为 2 ml。');
    const doseId = f.fact(user, dose, { field: '用量', value: '2', unit: 'ml' });
    const subtypePartial = await f.retrieval.retrieve({ user, query: '青禾修护水批发价和用量是多少？' });
    assert.deepEqual(subtypePartial.facts.map(fact => fact.id), [doseId]);
    assert.ok(subtypePartial.missingFields.some(field => field.endsWith('批发价')));
});

test('specification and historical qualifiers cannot borrow an unqualified canonical value or another quoted row', async context => {
    const f = setup(context), user = f.user('lookup_qualifiers');
    const general = f.memory(user, '青禾精华价格 168 元。');
    f.fact(user, general, { entity: '青禾精华' });
    for (const query of ['青禾精华50ml价格', '青禾精华2025年价格', '青禾精华去年价格']) {
        const response = await f.retrieval.retrieve({ user, query });
        assert.equal(response.requiresFacts, true); assert.deepEqual(response.facts, []); assert.ok(response.missingFields.length > 0);
    }
    const mixed = f.memory(user, '青禾精华30ml价格168元，青禾精华50ml价格288元。');
    f.fact(user, mixed, { entity: '青禾精华', evidence: mixed.content });
    const wrongRow = await f.retrieval.retrieve({ user, query: '青禾精华50ml价格' });
    assert.deepEqual(wrongRow.facts, []);
    const exact = f.memory(user, '青禾精华50ml在2025年的价格为 288 元。');
    const exactId = f.fact(user, exact, { entity: '青禾精华', value: '288', evidence: exact.content, validFrom: '2025-01-01', validUntil: '2025-12-31' });
    const correct = await f.retrieval.retrieve({ user, query: '青禾精华50毫升2025年价格' });
    assert.deepEqual(correct.facts.map(fact => fact.id), [exactId]); assert.deepEqual(correct.missingFields, []);
});

test('a confirmed policy can supply verbatim evidence without forcing a numeric fact record', async context => {
    const f = setup(context), user = f.user('lookup_policy');
    const source = f.memory(user, '公司请假制度要求提前提交书面申请。');
    const response = await f.retrieval.retrieve({ user, query: '公司的请假制度是什么？' });
    assert.equal(response.requiresFacts, false); assert.deepEqual(response.missingFields, []);
    assert.ok(response.evidence.some(evidence => evidence.sourceId === source.id));
});

test('unknown fields cannot borrow prices and missing fields are tracked separately for each named object', async context => {
    const f = setup(context), user = f.user('lookup_field_completeness');
    const first = f.memory(user, '青禾修护水价格168元，用量2ml。');
    f.fact(user, first); f.fact(user, first, { field: '用量', value: '2', unit: 'ml' });
    const second = f.memory(user, '长河精华价格288元。'); f.fact(user, second, { entity: '长河精华', value: '288' });
    for (const query of ['青禾修护水成分是什么？', '青禾修护水怎么使用？']) {
        const result = await f.retrieval.retrieve({ user, query }); assert.deepEqual(result.facts, [], query);
    }
    const both = await f.retrieval.retrieve({ user, query: '青禾修护水和长河精华的价格及用量分别是多少？' });
    assert.equal(both.facts.length, 3); assert.ok(both.missingFields.some(field => field.includes('长河精华') && field.includes('用量')));
});

test('current dates, Chinese dates and Chinese specification qualifiers cannot use an expired or different-size value', async context => {
    const f = setup(context, { config: { groundingNow: Date.parse('2026-10-29T04:00:00Z') } }), user = f.user('lookup_current_date');
    const source = f.memory(user, '2025年青禾精华50ml价格为268元。');
    const id = f.fact(user, source, { entity: '青禾精华', value: '268', validFrom: '2025-01-01', validUntil: '2025-12-31' });
    for (const query of ['青禾精华现在价格', '青禾精华今年价格', '青禾精华二〇二六年价格', '青禾精华三十毫升2025年价格']) {
        const result = await f.retrieval.retrieve({ user, query }); assert.deepEqual(result.facts, [], query);
    }
    const old = await f.retrieval.retrieve({ user, query: '青禾精华五十毫升二〇二五年价格' });
    assert.deepEqual(old.facts.map(fact => fact.id), [id]);
    const limited = f.memory(user, '青禾面霜零售价99元，仅限会员。');
    f.fact(user, limited, { entity: '青禾面霜', field: '零售价', value: '99', conditions: limited.content });
    const conditional = await f.retrieval.retrieve({ user, query: '青禾面霜零售价' });
    assert.equal(conditional.unresolvedConditions.length, 1);
});

test('the full authorized corpus is searched beyond twelve thousand newer chunks', async context => {
    const f = setup(context), user = f.user('lookup_large');
    const projectId = f.project(user);
    let target;
    f.db.transaction(() => {
        for (let index = 0; index < 80; index++) {
            const chunks = Array.from({ length: 160 }, () => '普通门店工作流程说明。');
            if (index === 79) chunks[159] = '古榕活动门店专用政策：预约必须由门店负责人确认。';
            const source = f.file(user, '已确认资料-' + index + '.txt', chunks,
                index < 40 ? {} : { scope: 'project_shared', projectId });
            if (index === 79) {
                target = source.chunks[159].id;
                f.db.prepare('UPDATE knowledge_files SET created_at=1,updated_at=1 WHERE id=?').run(source.id);
            }
        }
    })();
    const oldWindow = f.db.prepare(`SELECT chunk.id FROM knowledge_chunks chunk JOIN knowledge_files file ON file.id=chunk.file_id
        ORDER BY file.updated_at DESC,chunk.chunk_index LIMIT 12000`).all();
    assert.equal(oldWindow.some(row => row.id === target), false);
    const result = await f.retrieval.retrieve({ user, projectId, query: '古榕活动门店专用政策是什么？' });
    assert.equal(result.degraded, false);
    assert.ok(result.evidence.some(entry => entry.chunkId === target));
});

test('spreadsheet evidence includes its table heading and neighboring row context', async context => {
    const f = setup(context), user = f.user('lookup_table');
    const source = f.file(user, '收款表.txt', ['门店\t已付款\t待付款', '云杉店\t\t25000', '备注：空白表示尚未登记，不能视为已收款。']);
    const result = await f.retrieval.retrieve({ user, query: '云杉店待付款情况' });
    assert.equal(result.degraded, false);
    assert.ok(result.evidence.some(entry => entry.chunkId === source.chunks[1].id));
    assert.ok(result.evidence.some(entry => entry.chunkId === source.chunks[0].id));
    assert.ok(result.evidence.some(entry => entry.chunkId === source.chunks[2].id));
    assert.match(result.evidence.find(entry => entry.chunkIndex === 1).content, /\t\t25000/);
});

test('one expanded pass can retrieve a paraphrase while irrelevant orthogonal material stays excluded', async context => {
    const f = setup(context), user = f.user('lookup_paraphrase');
    const target = f.memory(user, '员工每年享有五天年假。', { vector: [0.4, Math.sqrt(0.84), 0] });
    const unrelated = f.memory(user, '办公室会议室的门牌颜色为浅绿色。');
    const result = await f.retrieval.retrieve({ user, query: '入职后能休几天带薪假？' });
    assert.equal(result.expanded, true); assert.equal(result.degraded, false);
    assert.ok(result.evidence.some(entry => entry.sourceId === target.id));
    assert.equal(result.evidence.some(entry => entry.sourceId === unrelated.id), false);
});

test('normal retrieval never expands audit visibility into other users private or another projects material', async context => {
    const f = setup(context), manager = f.user('lookup_manager', 'admin'), owner = f.user('lookup_member');
    const projectId = f.project(manager, [owner]);
    const otherProject = f.project(owner);
    const privateSource = f.memory(owner, '青禾修护水的私人报价是 88 元。');
    const projectPrivate = f.memory(owner, '青禾修护水的项目私人报价是 99 元。', { scope: 'project_private', projectId });
    const another = f.memory(owner, '青禾修护水在另一个项目的报价为 77 元。', { scope: 'project_shared', projectId: otherProject });
    const shared = f.memory(owner, '青禾修护水的项目公开售价是 168 元。', { scope: 'project_shared', projectId });
    const result = await f.retrieval.retrieve({ user: manager, projectId, query: '青禾修护水报价' });
    assert.ok(result.evidence.some(entry => entry.sourceId === shared.id));
    for (const source of [privateSource, projectPrivate, another]) assert.equal(result.evidence.some(entry => entry.sourceId === source.id), false);
});

test('sensitive questions never leave the server and embedding failure remains a visible unavailable state', async context => {
    const entered = [];
    const f = setup(context, { provider: { async embed(texts) { entered.push(texts); throw new Error('PRIVATE_UPSTREAM_DIAGNOSTIC'); } } });
    const user = f.user('lookup_fault'); f.memory(user, '青禾门店操作规范要求核对预约姓名。');
    const secret = await f.retrieval.retrieve({ user, query: '我的密钥是 sk-' + 'x'.repeat(24) });
    assert.equal(secret.degraded, true); assert.equal(entered.length, 0);
    const failed = await f.retrieval.retrieve({ user, query: '青禾门店操作规范' });
    assert.equal(failed.degraded, true); assert.equal(failed.code, 'GROUNDING_RETRIEVAL_UNAVAILABLE');
    assert.equal(JSON.stringify(failed).includes('PRIVATE_UPSTREAM_DIAGNOSTIC'), false);
});

test('source edits, deletion and revoke/reconfirm during embedding cannot return obsolete evidence', async context => {
    for (const change of ['edit', 'delete', 'reconfirm']) {
        const entered = gate(), waiting = gate();
        const f = setup(context, { provider: { async embed() { entered.resolve(); await waiting.promise; return [[1, 0, 0]]; } } });
        const user = f.user('lookup_race_' + change), source = f.memory(user, '青禾门店操作规范要求核对预约姓名。');
        const result = f.retrieval.retrieve({ user, query: '青禾门店操作规范' }); await entered.promise;
        if (change === 'edit') f.db.prepare("UPDATE memories SET content='新的操作规范',version=version+1 WHERE id=?").run(source.id);
        if (change === 'delete') f.db.prepare("UPDATE memories SET status='deleted',version=version+1,content='' WHERE id=?").run(source.id);
        if (change === 'reconfirm') {
            f.db.prepare('UPDATE source_confirmations SET revoked_at=? WHERE id=?').run(Date.now(), source.confirmationId);
            f.confirm('memory', source.id, user.id);
        }
        waiting.resolve(); const response = await result;
        assert.deepEqual(response.evidence, []); assert.deepEqual(response.facts, []); assert.equal(response.degraded, true);
    }
});

test('membership revoke-and-restore still invalidates the original lookup while cancellation settles a noncooperative provider', async context => {
    const entered = gate(), waiting = gate();
    const f = setup(context, { provider: { async embed() { entered.resolve(); await waiting.promise; return [[1, 0, 0]]; } } });
    const manager = f.user('lookup_lead'), user = f.user('lookup_reader'), projectId = f.project(manager, [user]);
    f.memory(manager, '青禾门店操作规范要求核对预约姓名。', { scope: 'project_shared', projectId });
    const result = f.retrieval.retrieve({ user, projectId, query: '青禾门店操作规范' }); await entered.promise;
    f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, user.id);
    f.db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,'member',?)").run(projectId, user.id, Date.now());
    waiting.resolve(); const response = await result;
    assert.equal(response.degraded, true); assert.equal(response.code, 'GROUNDING_ACCESS_CHANGED'); assert.deepEqual(response.evidence, []);

    const never = setup(context, { provider: { async embed() { await new Promise(() => {}); } } });
    const actor = never.user('lookup_cancel'); never.memory(actor, '青禾门店的预约规则。');
    const controller = new AbortController(), reason = new Error('Synthetic cancellation');
    const pending = never.retrieval.retrieve({ user: actor, query: '青禾门店预约规则', signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
});

test('a catalog/database failure is fail-closed and exposes no SQL or internal diagnostic text', async context => {
    const f = setup(context), user = f.user('lookup_broken');
    const retrieval = createGroundingRetrieval({ db: f.db, config: {}, provider: {},
        library: { catalog() { throw new Error('PRIVATE_SQL_AND_PATH'); } } });
    const result = await retrieval.retrieve({ user, query: '青禾门店资料' });
    assert.equal(result.degraded, true); assert.deepEqual(result.evidence, []); assert.deepEqual(result.facts, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SQL_AND_PATH'), false);
});
