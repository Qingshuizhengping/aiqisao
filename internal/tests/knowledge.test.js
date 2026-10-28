import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fixture, eventually, gate } from './helpers/application.js';
import { publicUser } from '../lib/access.js';
import { openDatabase } from '../lib/database.js';
import { createKnowledgeService } from '../lib/knowledge.js';

function raw(setup, client, method, route, bytes, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = bytes === undefined ? undefined : Buffer.from(bytes);
        const headers = { ...client?.headers, ...(body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {}), ...extraHeaders };
        for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
        const request = http.request({ hostname: '127.0.0.1', port: setup.port, path: route, method, headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                let body;
                try { body = JSON.parse(buffer.toString('utf8')); } catch { body = buffer; }
                resolve({ status: response.statusCode, body, bytes: buffer, headers: response.headers });
            });
        });
        request.on('error', reject);
        request.end(body);
    });
}

function upload(setup, person, name, content, scope = 'personal', projectId, headers) {
    const query = new URLSearchParams({ name, scope, ...(projectId ? { projectId } : {}) });
    return raw(setup, person, 'POST', '/api/knowledge/files?' + query, content, headers);
}

async function ready(person, id) {
    return eventually(async () => {
        const result = await person.call('GET', '/api/knowledge/files/' + id);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        if (result.body.file.state === 'failed') assert.fail(JSON.stringify(result.body.file));
        return result.body.file.state === 'ready' && result.body;
    }, 15000);
}

async function failed(person, id) {
    return eventually(async () => {
        const result = await person.call('GET', '/api/knowledge/files/' + id);
        return result.status === 200 && result.body.file.state === 'failed' && result.body.file;
    }, 15000);
}

function actor(setup, person) {
    return publicUser(setup.db.prepare('SELECT * FROM users WHERE id=?').get(person.id), setup.db);
}

function project(setup, manager, members) {
    const id = randomUUID();
    const now = Date.now();
    setup.db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run('fixture-enrolled', manager.id);
    setup.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(id, 'Knowledge project', manager.id, now, now);
    for (const person of [manager, ...members]) setup.db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(id, person.id, person.id === manager.id ? 'admin' : 'member', now);
    return id;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Minimal stored ZIPs keep parser fixtures independent from the implementation's archive library.
function zip(entries) {
    const files = [];
    const directory = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const filename = Buffer.from(name);
        const bytes = Buffer.from(content);
        const checksum = crc32(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
        files.push(local, filename, bytes);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
        directory.push(central, filename);
        offset += local.length + filename.length + bytes.length;
    }
    const central = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
    end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...files, central, end]);
}

function documentFixture() {
    return zip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>青禾项目预算是二万五千元。</w:t></w:r></w:p><w:p><w:r><w:t>延期需提前三天通知。</w:t></w:r></w:p></w:body></w:document>',
    });
}

function workbookFixture() {
    return zip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算表" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>青禾项目预算</t></si></sst>',
        'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>25000</v></c></row></sheetData></worksheet>',
    });
}

function pdfFixture() {
    const content = 'BT /F1 12 Tf 50 750 Td (Quasar project budget is 25000 yuan.) Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream',
    ];
    let document = '%PDF-1.4\n';
    const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
        offsets.push(Buffer.byteLength(document));
        document += (index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n';
    }
    const xref = Buffer.byteLength(document);
    document += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    document += 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(document);
}

test('knowledge upload persists exact bytes, extracts readable sources and scopes downloads', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const bob = setup.employee('bob');
    const content = Buffer.from('青禾项目资料\n项目预算：25000 元。\n延期需要提前三天通知。\n<svg onload="alert(1)">只是一段文件文字</svg>');
    const uploaded = await upload(setup, alice, '青禾资料.md', content);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const id = uploaded.body.file.id;
    const detail = await ready(alice, id);
    assert.equal(detail.file.scope, 'personal');
    assert.equal(detail.file.status, 'active');
    assert.match(detail.text, /项目预算：25000/);
    assert.match(detail.text, /<svg onload=/);
    assert.equal(detail.file.size, content.length);
    assert.ok(detail.file.chunkCount >= 1);
    const downloaded = await raw(setup, alice, 'GET', '/api/knowledge/files/' + id + '/download');
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.bytes, content);
    assert.match(downloaded.headers['content-disposition'], /^attachment;/);
    assert.match(downloaded.headers['cache-control'], /no-store/);
    assert.equal((await bob.call('GET', '/api/knowledge/files/' + id)).status, 404);
    assert.equal((await raw(setup, bob, 'GET', '/api/knowledge/files/' + id + '/download')).status, 404);
    const retrieved = await setup.knowledge.retrieve({ user: actor(setup, alice), query: '青禾项目预算' });
    assert.ok(retrieved.references.some(reference => reference.fileId === id && /25000/.test(reference.content)));
    assert.ok(retrieved.references.every(reference => reference.scope === 'personal'));
});

test('supported text, PDF, Word and Excel documents become searchable without external model calls', { timeout: 45000 }, async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const fixtures = [
        ['note.txt', Buffer.from('青禾项目：每月复核预算。'), /每月复核预算/],
        ['note.md', Buffer.from('# 青禾项目\n\n**预算**：25000 元。'), /25000/],
        ['budget.csv', Buffer.from('项目,预算\n青禾,25000\n'), /25000/],
        ['budget.json', Buffer.from('{"项目":"青禾","预算":25000}'), /25000/],
        ['budget.pdf', pdfFixture(), /Quasar project budget is 25000/],
        ['budget.docx', documentFixture(), /二万五千元/],
        ['budget.xlsx', workbookFixture(), /25000/],
    ];
    for (const [name, bytes, expected] of fixtures) {
        const result = await upload(setup, alice, name, bytes);
        assert.equal(result.status, 201, name + ': ' + JSON.stringify(result.body));
        const detail = await ready(alice, result.body.file.id);
        assert.match(detail.text, expected, name);
    }
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.extraction.length, 0);
});

test('raw file endpoints reject missing authentication, hostile origins and missing CSRF before insertion', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    assert.equal((await upload(setup, null, 'note.txt', 'ordinary content', 'personal', null, { Origin: setup.config.origin })).status, 401);
    assert.equal((await upload(setup, alice, 'note.txt', 'ordinary content', 'personal', null, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await upload(setup, alice, 'note.txt', 'ordinary content', 'personal', null, { 'X-CSRF-Token': undefined })).status, 403);
    const result = await alice.call('GET', '/api/knowledge/files?scope=personal');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.files, []);
});

test('knowledge rejects unsupported, oversized and malformed content with safe user errors', { timeout: 30000 }, async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    assert.equal((await upload(setup, alice, 'program.exe', 'MZ fixture')).status, 415);
    assert.equal((await upload(setup, alice, '../private.txt', 'fixture')).status, 400);
    assert.equal((await upload(setup, alice, 'large.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 65))).status, 413);
    for (const [name, content] of [['broken.pdf', 'not a PDF: PRIVATE-UPSTREAM-ERROR'], ['broken.docx', 'not a ZIP'], ['binary.txt', Buffer.from([0, 1, 2, 3])]]) {
        const result = await upload(setup, alice, name, content);
        if (result.status === 201) {
            const error = await failed(alice, result.body.file.id);
            assert.ok(error.errorCode);
            assert.ok(error.errorMessage);
            assert.doesNotMatch(error.errorMessage, /PRIVATE-UPSTREAM|stack|node_modules|H:\\|\/opt\//);
            assert.equal(error.canRetry, true);
        } else assert.equal(result.status, 400, name + ': ' + JSON.stringify(result.body));
    }
});

test('Office parsing rejects declared archive expansion and XML external entities', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const oversized = documentFixture();
    const directory = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(directory >= 0);
    oversized.writeUInt32LE(13 * 1024 * 1024, directory + 24);
    const entities = zip({ 'word/document.xml': '<?xml version="1.0"?><!DOCTYPE doc [<!ENTITY secret SYSTEM "file:///private/secret.txt">]><w:document><w:p><w:t>&secret;</w:t></w:p></w:document>' });
    for (const [name, bytes, code] of [['expanded.docx', oversized, 'KNOWLEDGE_ARCHIVE_LIMIT'], ['entity.docx', entities, 'KNOWLEDGE_XML_UNSAFE']]) {
        const uploaded = await upload(setup, alice, name, bytes);
        assert.equal(uploaded.status, 201);
        assert.equal((await failed(alice, uploaded.body.file.id)).errorCode, code);
    }
    assert.equal(setup.calls.length, 0);
});

test('credential-bearing files and query credentials never reach the embedding provider', async context => {
    const embeddings = [];
    const setup = await fixture(context, { provider: { async embed(texts) {
        embeddings.push(...texts);
        return texts.map(() => [1, 0, 0, 0]);
    } } });
    const alice = setup.employee('alice');
    const rejected = await upload(setup, alice, 'credentials.txt', 'API_KEY=sk-syntheticfixturecredentials1234567890');
    assert.equal(rejected.status, 201);
    assert.equal((await failed(alice, rejected.body.file.id)).errorCode, 'KNOWLEDGE_SECRET_BLOCKED');
    assert.deepEqual(embeddings, []);
    const ordinary = await upload(setup, alice, 'budget.txt', '青禾项目预算25000元。');
    await ready(alice, ordinary.body.file.id);
    const count = embeddings.length;
    const found = await setup.knowledge.retrieve({ user: actor(setup, alice), query: '青禾预算，密钥是 sk-syntheticfixturecredentials1234567890' });
    assert.equal(found.degraded, true);
    assert.equal(embeddings.length, count);
    assert.equal(embeddings.some(text => text.includes('syntheticfixturecredentials')), false);
});

test('stopping document work settles even when an embedding provider ignores cancellation', { timeout: 8000 }, async context => {
    const entered = gate();
    const setup = await fixture(context, { config: { embeddingTimeoutMs: 2000 }, provider: { async embed() {
        entered.resolve();
        return new Promise(() => {});
    } } });
    const alice = setup.employee('alice');
    const uploaded = await upload(setup, alice, 'budget.txt', '青禾项目预算25000元。');
    assert.equal(uploaded.status, 201);
    await entered.promise;
    let deadline;
    try {
        await Promise.race([setup.knowledge.stop(), new Promise((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Document shutdown did not settle after cancellation')), 1500);
        })]);
    } finally { clearTimeout(deadline); }
    const state = setup.db.prepare('SELECT processing_state,index_state,error_code FROM knowledge_files WHERE id=?').get(uploaded.body.file.id);
    assert.equal(state.processing_state, 'ready');
    assert.equal(state.index_state, 'failed');
    assert.equal(state.error_code, 'KNOWLEDGE_INTERRUPTED');
});

test('private and project files stay isolated from other members and normal system administrator APIs', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const bob = setup.employee('bob');
    const manager = setup.employee('manager');
    const outsider = setup.employee('outsider');
    const admin = setup.employee('system', 'admin');
    const projectId = project(setup, manager, [alice, bob]);
    const personal = await upload(setup, alice, 'personal.txt', '个人青禾预算');
    const privateProject = await upload(setup, alice, 'private.txt', '项目青禾私有预算', 'project_private', projectId);
    assert.equal(personal.status, 201);
    assert.equal(privateProject.status, 201);
    for (const person of [bob, manager, admin]) {
        assert.deepEqual((await person.call('GET', '/api/knowledge/files?scope=personal')).body.files, []);
        for (const id of [personal.body.file.id, privateProject.body.file.id]) {
            assert.equal((await person.call('GET', '/api/knowledge/files/' + id)).status, 404);
            assert.equal((await person.call('DELETE', '/api/knowledge/files/' + id)).status, 404);
        }
    }
    for (const person of [outsider, admin]) {
        assert.equal((await person.call('GET', '/api/knowledge/files?scope=project_private&projectId=' + projectId)).status, 403);
        assert.equal((await upload(setup, person, 'blocked.txt', 'blocked', 'project_shared', projectId)).status, 403);
    }
});

test('shared candidate files require project review before member downloads or chat retrieval', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const bob = setup.employee('bob');
    const manager = setup.employee('manager');
    const projectId = project(setup, manager, [alice, bob]);
    const uploaded = await upload(setup, alice, 'shared.txt', '青禾项目的预算为25000元。', 'project_shared', projectId);
    assert.equal(uploaded.status, 201);
    const id = uploaded.body.file.id;
    await ready(alice, id);
    assert.equal(uploaded.body.file.status, 'candidate');
    assert.equal((await bob.call('GET', '/api/knowledge/files/' + id)).status, 404);
    assert.equal((await raw(setup, bob, 'GET', '/api/knowledge/files/' + id + '/download')).status, 404);
    assert.deepEqual((await setup.knowledge.retrieve({ user: actor(setup, bob), projectId, query: '青禾项目预算' })).references, []);
    assert.equal((await alice.call('POST', '/api/knowledge/files/' + id + '/review', { decision: 'approve' })).status, 403);
    const approved = await manager.call('POST', '/api/knowledge/files/' + id + '/review', { decision: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.file.status, 'active');
    assert.equal((await bob.call('GET', '/api/knowledge/files/' + id)).status, 200);
    assert.equal((await raw(setup, bob, 'GET', '/api/knowledge/files/' + id + '/download')).status, 200);
    assert.ok((await setup.knowledge.retrieve({ user: actor(setup, bob), projectId, query: '青禾项目预算' })).references.some(reference => reference.fileId === id));
    assert.equal((await alice.call('DELETE', '/api/knowledge/files/' + id)).status, 403);
    assert.equal((await manager.call('DELETE', '/api/knowledge/files/' + id)).status, 200);
    assert.deepEqual((await setup.knowledge.retrieve({ user: actor(setup, bob), projectId, query: '青禾项目预算' })).references, []);
});

test('archived projects keep file operations read-only and a candidate author can withdraw', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const manager = setup.employee('manager');
    const projectId = project(setup, manager, [alice]);
    const first = await upload(setup, alice, 'candidate.txt', '青禾项目资料候选', 'project_shared', projectId);
    assert.equal((await alice.call('DELETE', '/api/knowledge/files/' + first.body.file.id)).status, 200);
    assert.equal((await alice.call('GET', '/api/knowledge/files/' + first.body.file.id)).status, 404);
    const uploaded = await upload(setup, alice, 'candidate2.txt', '青禾项目资料候选第二份', 'project_shared', projectId);
    setup.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(projectId);
    assert.equal((await upload(setup, manager, 'blocked.txt', 'archived upload', 'project_shared', projectId)).status, 409);
    assert.equal((await manager.call('POST', '/api/knowledge/files/' + uploaded.body.file.id + '/review', { decision: 'approve' })).status, 409);
    assert.equal((await manager.call('POST', '/api/knowledge/files/' + uploaded.body.file.id + '/retry', {})).status, 409);
    assert.equal((await alice.call('DELETE', '/api/knowledge/files/' + uploaded.body.file.id)).status, 409);
});

test('chat context includes relevant document excerpts and persisted source metadata but not another user library', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const bob = setup.employee('bob');
    const own = await upload(setup, alice, '青禾手册.txt', '青禾项目预算是25000元，延期提前三天通知。');
    const hidden = await upload(setup, bob, 'hidden.txt', '绝密其他员工的青禾预算是99999元。');
    await ready(alice, own.body.file.id); await ready(bob, hidden.body.file.id);
    const conversation = await setup.conversation(alice);
    const run = await alice.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '青禾项目预算多少？', requestId: randomUUID() });
    assert.equal(run.status, 202);
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(run.body.run.id).state === 'completed');
    const contextText = JSON.stringify(setup.calls[0]);
    assert.match(contextText, /青禾项目预算是25000/);
    assert.doesNotMatch(contextText, /绝密其他员工|99999/);
    const result = await alice.call('GET', '/api/chat/runs/' + run.body.run.id);
    assert.ok(result.body.message.metadata.files.some(source => source.fileId === own.body.file.id));
    assert.equal(result.body.message.metadata.files.some(source => source.fileId === hidden.body.file.id), false);
});

test('deleting a file while query embedding is pending prevents stale excerpts from returning', { timeout: 20000 }, async context => {
    const release = gate(); const entered = gate();
    let blocked = false;
    context.after(() => release.resolve());
    const setup = await fixture(context, { provider: { async embed(texts) {
        if (blocked && texts[0] === '青禾预算检索') { entered.resolve(); await release.promise; }
        return texts.map(() => [1, 0, 0, 0]);
    } } });
    const alice = setup.employee('alice');
    const uploaded = await upload(setup, alice, 'budget.txt', '青禾预算检索资料，预算25000元。');
    await ready(alice, uploaded.body.file.id);
    blocked = true;
    const pending = setup.knowledge.retrieve({ user: actor(setup, alice), query: '青禾预算检索' });
    await entered.promise;
    assert.equal((await alice.call('DELETE', '/api/knowledge/files/' + uploaded.body.file.id)).status, 200);
    release.resolve();
    assert.deepEqual((await pending).references, []);
});

test('revoked project membership is rechecked after an asynchronous query embedding', { timeout: 20000 }, async context => {
    const release = gate(); const entered = gate();
    let blocked = false;
    context.after(() => release.resolve());
    const setup = await fixture(context, { provider: { async embed(texts) {
        if (blocked && texts[0] === '青禾项目预算检索') { entered.resolve(); await release.promise; }
        return texts.map(() => [1, 0, 0, 0]);
    } } });
    const alice = setup.employee('alice');
    const manager = setup.employee('manager');
    const projectId = project(setup, manager, [alice]);
    const uploaded = await upload(setup, manager, 'shared.txt', '青禾项目预算检索资料：25000元。', 'project_shared', projectId);
    await ready(manager, uploaded.body.file.id);
    blocked = true;
    const pending = setup.knowledge.retrieve({ user: actor(setup, alice), projectId, query: '青禾项目预算检索' });
    await entered.promise;
    setup.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, alice.id);
    release.resolve();
    await assert.rejects(pending, error => error.status === 403);
});

test('embedding failures keep keyword retrieval available and an explicit retry restores semantic indexing', async context => {
    let unavailable = true;
    const setup = await fixture(context, { provider: { async embed(texts) {
        if (unavailable) throw new Error('private embedding upstream diagnostic');
        return texts.map(() => [1, 0, 0, 0]);
    } } });
    const alice = setup.employee('alice');
    const uploaded = await upload(setup, alice, 'fallback.txt', '青禾项目预算25000元。');
    const detail = await ready(alice, uploaded.body.file.id);
    assert.equal(detail.file.indexState, 'failed');
    const fallback = await setup.knowledge.retrieve({ user: actor(setup, alice), query: '青禾项目预算' });
    assert.equal(fallback.degraded, true);
    assert.ok(fallback.references.some(reference => reference.fileId === uploaded.body.file.id));
    unavailable = false;
    assert.equal((await alice.call('POST', '/api/knowledge/files/' + uploaded.body.file.id + '/retry', {})).status, 200);
    await eventually(async () => (await alice.call('GET', '/api/knowledge/files/' + uploaded.body.file.id)).body.file.indexState === 'ready', 15000);
});

test('project administrators reading another member chat receive only shared file source metadata', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const manager = setup.employee('manager');
    const projectId = project(setup, manager, [alice]);
    const personal = await upload(setup, alice, '个人预算.txt', '青禾预算个人资料：25000元。');
    const privateProject = await upload(setup, alice, '项目内个人预算.txt', '青禾预算项目内个人资料：26000元。', 'project_private', projectId);
    const shared = await upload(setup, manager, '项目共享预算.txt', '青禾预算共享资料：27000元。', 'project_shared', projectId);
    for (const [person, file] of [[alice, personal], [alice, privateProject], [manager, shared]]) {
        assert.equal(file.status, 201, JSON.stringify(file.body));
        await ready(person, file.body.file.id);
    }
    const conversation = await setup.conversation(alice, projectId);
    const created = await alice.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '青禾预算资料有哪些？', requestId: randomUUID() });
    assert.equal(created.status, 202);
    await eventually(() => setup.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(created.body.run.id).state === 'completed');
    const owner = await alice.call('GET', '/api/chat/runs/' + created.body.run.id);
    assert.ok(owner.body.message.metadata.files.some(file => file.scope === 'personal'));
    assert.ok(owner.body.message.metadata.files.some(file => file.scope === 'project_private'));
    assert.ok(owner.body.message.metadata.files.some(file => file.scope === 'project_shared'));
    const managerRun = await manager.call('GET', '/api/chat/runs/' + created.body.run.id);
    assert.ok(managerRun.body.message.metadata.files.every(file => file.scope === 'project_shared'));
    assert.doesNotMatch(JSON.stringify(managerRun.body.message.metadata.files), /个人预算|个人资料/);
    const managerConversation = await manager.call('GET', '/api/conversations/' + conversation.id);
    assert.ok(managerConversation.body.messages.find(message => message.role === 'assistant').metadata.files.every(file => file.scope === 'project_shared'));
    let events = '';
    const stream = await manager.stream('/api/chat/runs/' + created.body.run.id + '/events', chunk => { events += chunk; });
    await stream.ended;
    assert.doesNotMatch(events, /个人预算|个人资料/);
});

test('revalidation drops deleted file snapshots without trusting caller supplied text', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const uploaded = await upload(setup, alice, 'budget.txt', '青禾项目的预算是25000元。');
    await ready(alice, uploaded.body.file.id);
    const user = actor(setup, alice);
    const result = await setup.knowledge.retrieve({ user, query: '青禾项目预算' });
    assert.ok(result.references.length);
    const forged = result.references.map(reference => ({ ...reference, content: 'caller supplied text' }));
    const current = setup.knowledge.revalidate({ user, references: forged });
    assert.ok(current.some(reference => /25000/.test(reference.content)));
    assert.equal(current.some(reference => reference.content === 'caller supplied text'), false);
    assert.equal((await alice.call('DELETE', '/api/knowledge/files/' + uploaded.body.file.id)).status, 200);
    assert.deepEqual(setup.knowledge.revalidate({ user, references: result.references }), []);
});

test('queued source bytes survive SQLite backup and reopen and are parsed without re-uploading', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    await setup.knowledge.stop();
    const uploaded = await upload(setup, alice, 'persistent.txt', '青禾项目持久资料预算25000元。');
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.file.state, 'queued');
    const directory = await mkdtemp(join(tmpdir(), 'xiaowei-knowledge-'));
    const snapshot = join(directory, 'snapshot.sqlite');
    const tmpRoot = resolve(tmpdir());
    const cleanupRelative = relative(tmpRoot, resolve(directory));
    assert.ok(cleanupRelative && !cleanupRelative.startsWith('..') && !isAbsolute(cleanupRelative));
    let reopened; let service;
    context.after(async () => { await service?.stop(); reopened?.close(); await rm(directory, { recursive: true, force: true }); });
    await setup.db.backup(snapshot);
    reopened = openDatabase(snapshot);
    service = createKnowledgeService({ db: reopened, config: setup.config, provider: setup.provider });
    await service.start();
    await eventually(() => reopened.prepare('SELECT processing_state FROM knowledge_files WHERE id=?').get(uploaded.body.file.id)?.processing_state === 'ready', 15000);
    const retrieved = await service.retrieve({ user: actor(setup, alice), query: '青禾项目持久资料预算' });
    assert.ok(retrieved.references.some(reference => reference.fileId === uploaded.body.file.id && /25000/.test(reference.content)));
});

test('system administrators inspect files through a dedicated audited read-only interface', async context => {
    const setup = await fixture(context);
    const alice = setup.employee('alice');
    const admin = setup.employee('system', 'admin');
    const uploaded = await upload(setup, alice, 'review.txt', '青禾内部文件审计资料预算25000元。');
    await ready(alice, uploaded.body.file.id);
    const list = await admin.call('GET', '/api/admin/audit/files?userId=' + alice.id + '&q=' + encodeURIComponent('审计资料'));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.files.some(file => file.id === uploaded.body.file.id));
    const detail = await admin.call('GET', '/api/admin/audit/files/' + uploaded.body.file.id);
    assert.equal(detail.status, 200);
    assert.match(detail.body.text, /内部文件审计资料/);
    for (const field of ['canDelete', 'canRetry', 'canReview', 'canDownload']) assert.equal(detail.body.file[field], false);
    assert.equal((await admin.call('GET', '/api/knowledge/files/' + uploaded.body.file.id)).status, 404);
    assert.equal((await admin.call('DELETE', '/api/admin/audit/files/' + uploaded.body.file.id)).status, 404);
    assert.equal((await admin.call('POST', '/api/admin/audit/files/' + uploaded.body.file.id + '/review', { decision: 'reject' })).status, 404);
    assert.equal((await alice.call('GET', '/api/admin/audit/files')).status, 403);
    assert.equal((await alice.call('GET', '/api/admin/audit/files/' + uploaded.body.file.id)).status, 403);
    assert.ok(setup.db.prepare("SELECT COUNT(*) AS count FROM audit_records WHERE actor_id=? AND target_type='knowledge_file'").get(admin.id).count >= 1);
});
