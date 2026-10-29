import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, gate } from './helpers/application.js';
import { sparseWorkbookFixture } from './helpers/office.js';
import { repairXlsx, XLSX_REPAIR_VERSION } from '../scripts/repair-xlsx.mjs';
import { parseKnowledgeFile } from '../lib/knowledge-parser.js';
import { vectorBuffer } from '../lib/memory-store.js';

async function setupRepair(context) {
    const setup = await fixture(context, { start: false });
    const root = await fs.mkdtemp(join(tmpdir(), 'employee-xlsx-repair-'));
    const safe = relative(resolve(tmpdir()), resolve(root));
    assert.ok(safe && !safe.startsWith('..') && !isAbsolute(safe));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const owner = setup.employee('repair_owner');
    const manager = setup.employee('repair_manager');
    const projectId = randomUUID();
    const now = Date.now();
    setup.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, 'Repair project', manager.id, now, now);
    for (const person of [owner, manager]) setup.db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(projectId, person.id, person === manager ? 'admin' : 'member', now);
    const receipts = join(root, 'private-receipts');
    function file({ scope = 'personal', status = 'active', bytes = sparseWorkbookFixture(), archived = false } = {}) {
        const id = randomUUID();
        const oldText = '门店\t已付款\t待付款\n青禾店\t25000';
        const p = scope === 'personal' ? null : projectId;
        setup.db.prepare(`INSERT INTO knowledge_files(id,scope,user_id,project_id,name,extension,mime_type,size_bytes,sha256,original,
            text_content,status,processing_state,index_state,version,chunk_count,character_count,created_at,updated_at)
            VALUES(?,?,?,?,?,'xlsx',?,?,?,?,?,?,'ready','ready',1,1,?,?,?)`).run(id, scope, owner.id, p,
                'payments.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes.length,
                createHash('sha256').update(bytes).digest('hex'), status === 'deleted' ? null : bytes, oldText,
                status, oldText.length, now, now);
        if (status !== 'deleted') setup.db.prepare(`INSERT INTO knowledge_chunks(id,file_id,file_version,chunk_index,content,embedding,embedding_model,embedding_dimension)
            VALUES(?,?,1,0,?,?,?,3)`).run(randomUUID(), id, oldText, vectorBuffer([1, 0, 0]), 'old-embed');
        if (archived) setup.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(projectId);
        return id;
    }
    return { ...setup, owner, manager, projectId, root, receipts, file };
}

test('XLSX repair reparses original bytes, advances version once and queues fresh chunks without provider calls', async context => {
    const setup = await setupRepair(context);
    const id = setup.file();
    const result = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.deepEqual(result, { repaired: 1, alreadyRepaired: 0, deferred: 0, failed: 0, skipped: 0 });
    const row = setup.db.prepare('SELECT * FROM knowledge_files WHERE id=?').get(id);
    assert.match(row.text_content, /青禾店\t\t25000/);
    assert.equal(row.version, 2);
    assert.equal(row.processing_state, 'ready');
    assert.equal(row.index_state, 'queued');
    const chunks = setup.db.prepare('SELECT * FROM knowledge_chunks WHERE file_id=?').all(id);
    assert.ok(chunks.length);
    assert.ok(chunks.every(chunk => chunk.file_version === 2 && chunk.embedding === null && chunk.embedding_model === null));
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.extraction.length, 0);
    let reparsed = 0;
    const again = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts, async parseFile() { reparsed++; throw Error('Already repaired file should not be parsed'); } });
    assert.equal(again.alreadyRepaired, 1);
    assert.equal(reparsed, 0);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(id).version, 2);
    const receiptPath = join(setup.receipts, XLSX_REPAIR_VERSION + '.json');
    const receipt = await fs.readFile(receiptPath, 'utf8');
    assert.doesNotMatch(receipt, /青禾|payments|25000|已付款/);
    if (process.platform !== 'win32') {
        assert.equal((await fs.stat(setup.receipts)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
    }
});

test('repair is isolated per file, skips tombstones and defers archived projects until restored', async context => {
    const setup = await setupRepair(context);
    const good = setup.file();
    const malformed = setup.file({ bytes: Buffer.from('invalid xlsx fixture') });
    const deleted = setup.file({ status: 'deleted' });
    const archived = setup.file({ scope: 'project_shared', archived: true });
    const before = setup.db.prepare('SELECT text_content,version FROM knowledge_files WHERE id=?').get(malformed);
    const result = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.deepEqual(result, { repaired: 1, alreadyRepaired: 0, deferred: 1, failed: 1, skipped: 1 });
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(good).version, 2);
    assert.deepEqual(setup.db.prepare('SELECT text_content,version FROM knowledge_files WHERE id=?').get(malformed), before);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(deleted).version, 1);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(archived).version, 1);
    setup.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(setup.projectId);
    const next = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.equal(next.repaired, 1);
    assert.equal(next.alreadyRepaired, 1);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(archived).version, 2);
});

test('repair follows project ownership for approved shared files while private files and candidates retain author gates', async context => {
    const setup = await setupRepair(context);
    const shared = setup.file({ scope: 'project_shared' });
    const candidate = setup.file({ scope: 'project_shared', status: 'candidate' });
    const personal = setup.file();
    setup.db.prepare('UPDATE users SET active=0,deleted_at=? WHERE id=?').run(Date.now(), setup.owner.id);
    setup.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(setup.projectId, setup.owner.id);
    const result = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.equal(result.repaired, 1);
    assert.equal(result.deferred, 2);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(shared).version, 2);
    for (const id of [candidate, personal]) assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(id).version, 1);
});

test('an interrupted receipt commit is recovered by exact parsed digest without a second version increment', async context => {
    const setup = await setupRepair(context);
    const id = setup.file();
    await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    const filename = join(setup.receipts, XLSX_REPAIR_VERSION + '.json');
    const journal = JSON.parse(await fs.readFile(filename, 'utf8'));
    journal.files[id].state = 'intent';
    await fs.writeFile(filename, JSON.stringify(journal));
    const result = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.equal(result.alreadyRepaired, 1);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(id).version, 2);
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).files[id].recovered, true);
});

test('repair rechecks versions, deletes, project archive revisions and author access after asynchronous parsing', async context => {
    for (const action of ['version', 'delete', 'archive', 'revoke']) {
        const setup = await setupRepair(context);
        const id = setup.file({ scope: action === 'archive' ? 'project_shared' : 'personal' });
        const entered = gate(), release = gate();
        context.after(() => release.resolve());
        const pending = repairXlsx({ db: setup.db, receiptDirectory: setup.receipts, async parseFile(input) {
            entered.resolve(); await release.promise; return parseKnowledgeFile(input);
        } });
        await entered.promise;
        if (action === 'version') setup.db.prepare("UPDATE knowledge_files SET version=version+1,text_content='newer-replacement' WHERE id=?").run(id);
        if (action === 'delete') setup.db.prepare("UPDATE knowledge_files SET status='deleted',original=NULL,text_content='',version=version+1 WHERE id=?").run(id);
        if (action === 'archive') {
            setup.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(setup.projectId);
            setup.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(setup.projectId);
        }
        if (action === 'revoke') setup.db.prepare('UPDATE users SET active=0 WHERE id=?').run(setup.owner.id);
        release.resolve();
        const result = await pending;
        assert.equal(result.repaired, 0, action);
        assert.equal(result.deferred, 1, action);
        assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE file_id=? AND file_version>1').get(id).count, 0, action);
        assert.doesNotMatch(setup.db.prepare('SELECT text_content FROM knowledge_files WHERE id=?').get(id).text_content, /青禾店\t\t25000/, action);
    }
});

test('repair refuses a public receipt directory before parsing or writing data', async context => {
    const setup = await setupRepair(context);
    const id = setup.file();
    await assert.rejects(repairXlsx({ db: setup.db, receiptDirectory: join(setup.root, 'public') }), /outside public/);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(id).version, 1);
});

test('parallel repair runs cannot overwrite the private journal and an abandoned process lock can be retried', async context => {
    const setup = await setupRepair(context);
    const id = setup.file();
    const entered = gate(), release = gate();
    context.after(() => release.resolve());
    const pending = repairXlsx({ db: setup.db, receiptDirectory: setup.receipts, async parseFile(input) {
        entered.resolve(); await release.promise; return parseKnowledgeFile(input);
    } });
    await entered.promise;
    await assert.rejects(repairXlsx({ db: setup.db, receiptDirectory: setup.receipts }), /already running/);
    release.resolve();
    assert.equal((await pending).repaired, 1);
    await fs.writeFile(join(setup.receipts, XLSX_REPAIR_VERSION + '.lock'), JSON.stringify({ pid: 2147483647, token: randomUUID() }), { mode: 0o600 });
    const again = await repairXlsx({ db: setup.db, receiptDirectory: setup.receipts });
    assert.equal(again.alreadyRepaired, 1);
    assert.equal(setup.db.prepare('SELECT version FROM knowledge_files WHERE id=?').get(id).version, 2);
});
