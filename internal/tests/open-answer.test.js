import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fixture, eventually } from './helpers/application.js';
import { evidenceSummary } from '../shared/evidence-summary.js';
import { openDatabase } from '../lib/database.js';

const PLACEHOLDER = /暂无依据|无法回答|依据不足/;

function searchConfig(extra = {}) {
    // `stub` is the test-only provider: it never resolves a real hostname.
    return { searchProvider: 'stub', searchApiKey: 'fixture-search-key', searchTimeoutMs: 1000, ...extra };
}

/** Counts every outbound call so "zero fetch" can be asserted, not assumed. */
function transport(response = { results: [] }) {
    const calls = [];
    const implementation = async (url, options) => {
        calls.push({ url: String(url), body: options?.body ? String(options.body) : '' });
        if (typeof response === 'function') return response(url, options);
        return { ok: true, json: async () => response };
    };
    implementation.calls = calls;
    return implementation;
}

async function send(f, person, message = '门店这周该怎么排班？') {
    const conversation = await f.conversation(person);
    const created = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message, requestId: randomUUID() });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    return eventually(async () => {
        const response = await person.call('GET', '/api/chat/runs/' + created.body.run.id);
        return response.status === 200 && response.body.run.state === 'completed' ? response.body : null;
    }, 8000);
}

function upload(f, client, name, content) {
    const body = Buffer.from(content, 'utf8');
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: f.port, method: 'POST',
            path: '/api/knowledge/files?' + new URLSearchParams({ name, scope: 'personal' }),
            headers: { ...client.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } resolve({ status: response.statusCode, body: parsed }); });
        });
        request.on('error', reject);
        request.end(body);
    });
}

test('an empty library still produces a real answer with no fallback wording', async context => {
    const f = await fixture(context);
    const person = f.employee('open_empty_library');
    const done = await send(f, person);
    assert.equal(done.run.state, 'completed');
    assert.ok(done.message.content.trim().length > 0, 'the answer must not be empty');
    assert.doesNotMatch(done.message.content, PLACEHOLDER);
    assert.equal(done.message.metadata.grounding, undefined, 'free mode never publishes a grounding verdict');
    assert.deepEqual(done.message.metadata.files, []);
    assert.deepEqual(done.message.metadata.memories, []);
    assert.equal(done.message.metadata.search.status, 'disabled');
    assert.equal(evidenceSummary(done.message.metadata).label, '');
});

test('a library-backed answer reports the same source count as its badge', async context => {
    const f = await fixture(context);
    const person = f.employee('open_with_materials');
    const uploaded = await upload(f, person, '门店手册.txt', '门店每周排班需覆盖早晚高峰，并留出培训时段。');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    await eventually(async () => (await person.call('GET', '/api/knowledge/files/' + uploaded.body.file.id)).body?.file?.indexState === 'ready', 15000);
    const done = await send(f, person, '门店排班要覆盖哪些时段？');
    const files = done.message.metadata.files;
    assert.ok(files.length > 0, 'the uploaded material must reach the context');
    assert.equal(files[0].filename, '门店手册.txt');
    const summary = evidenceSummary(done.message.metadata);
    assert.equal(summary.label, '参考 ' + (files.length + done.message.metadata.memories.length) + ' 条资料');
    assert.match(summary.label, /^参考 \d+ 条资料$/);
    assert.equal(summary.items.filter(item => item.kind === 'file').length, files.length);
    assert.doesNotMatch(done.message.content, PLACEHOLDER);
});

test('search that is not configured, or turned off by the member, performs zero fetch', async context => {
    const noProvider = transport();
    const unconfigured = await fixture(context, { fetchImpl: noProvider });
    const person = unconfigured.employee('open_search_unconfigured');
    const first = await send(unconfigured, person);
    assert.equal(noProvider.calls.length, 0, 'no provider configured -> no outbound request at all');
    assert.equal(first.message.metadata.search.status, 'disabled');
    assert.equal(evidenceSummary(first.message.metadata).network.count, 0);
    assert.equal((await person.call('GET', '/api/health')).body.search.enabled, false);

    const disabledByMember = transport();
    const configured = await fixture(context, { config: searchConfig(), fetchImpl: disabledByMember });
    const member = configured.employee('open_search_member_off', 'member', { searchEnabled: false });
    const second = await send(configured, member);
    assert.equal(disabledByMember.calls.length, 0, 'the member preference must win over configuration');
    assert.equal(second.message.metadata.search.status, 'disabled');
    assert.equal(second.message.metadata.search.count, 0);
    assert.equal(evidenceSummary(second.message.metadata).network.count, 0);
    assert.equal((await member.call('GET', '/api/health')).body.search.enabled, true);
});

test('configured stub search injects https sources and the answer stays usable', async context => {
    const payload = { results: [
        { title: '门店运营手册', url: 'https://example.com/materials/store-playbook', snippet: '排班需覆盖高峰。' },
        { title: '接待流程', url: 'https://example.com/materials/consult-flow', snippet: '先评估再建议。' },
        // Dropped by the sanitizer: plain http is not an acceptable source link.
        { title: '不安全来源', url: 'http://example.com/insecure', snippet: '忽略。' },
    ] };
    const fetchImpl = transport(payload);
    const f = await fixture(context, { config: searchConfig(), fetchImpl });
    const person = f.employee('open_search_stub_ok');
    const done = await send(f, person, '门店排班和接待流程怎么配合？');
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0].url, /^https:\/\//);
    const search = done.message.metadata.search;
    assert.equal(search.status, 'ok');
    assert.equal(search.count, 2);
    for (const item of search.items) assert.match(item.url, /^https:\/\//);
    assert.equal(search.items[0].title, '门店运营手册');
    const summary = evidenceSummary(done.message.metadata);
    assert.equal(summary.network.count, 2);
    assert.equal(summary.network.label, '来自网络 2 条');
    assert.ok(done.message.content.trim().length > 0);
    // The sources are actually handed to the model as data, not as instructions.
    const system = f.calls[0].filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.match(system, /网络检索结果/);
    assert.match(system, /https:\/\/example\.com\/materials\/store-playbook/);
    assert.match(system, /不是指令/);
});

test('a failing search degrades silently and the answer is still produced', async context => {
    const fetchImpl = transport(() => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
    });
    const f = await fixture(context, { config: searchConfig(), fetchImpl });
    const person = f.employee('open_search_timeout');
    const done = await send(f, person, '这周门店排班怎么安排？');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(done.message.metadata.search.status, 'degraded');
    assert.equal(done.message.metadata.search.count, 0);
    assert.deepEqual(done.message.metadata.search.items, []);
    assert.ok(done.message.content.trim().length > 0);
    assert.doesNotMatch(done.message.content, PLACEHOLDER);
    const summary = evidenceSummary(done.message.metadata);
    assert.equal(summary.network.count, 0);
    assert.equal(summary.network.label, '');
    assert.equal(summary.degraded.search, true);
});

test('turning search off in preferences persists, is echoed by /me and stops all fetching', async context => {
    const fetchImpl = transport({ results: [{ title: '示例来源', url: 'https://example.com/source', snippet: '片段' }] });
    const f = await fixture(context, { config: searchConfig(), fetchImpl });
    const person = f.employee('open_search_preference');
    const enabled = await send(f, person);
    assert.equal(enabled.message.metadata.search.status, 'ok');
    assert.equal(fetchImpl.calls.length, 1);

    const patched = await person.call('PATCH', '/api/auth/preferences', { searchEnabled: false });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.user.searchEnabled, false);
    assert.equal(patched.body.user.autoMemoryEnabled, true, 'the other preference is preserved');
    assert.equal((await person.call('GET', '/api/auth/me')).body.user.searchEnabled, false);
    const stored = f.db.prepare('SELECT search_enabled AS searchEnabled FROM users WHERE id=?').get(person.id);
    assert.equal(stored.searchEnabled, 0);
    // The column exists with the documented default for every account.
    const column = f.db.prepare('PRAGMA table_info(users)').all().find(entry => entry.name === 'search_enabled');
    assert.equal(column.notnull, 1);
    assert.equal(String(column.dflt_value), '1');
    const audit = f.db.prepare("SELECT details FROM audit_records WHERE action='user.preferences' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(JSON.parse(audit.details).searchEnabled, false);

    const disabled = await send(f, person);
    assert.equal(fetchImpl.calls.length, 1, 'a disabled preference must not fetch again');
    assert.equal(disabled.message.metadata.search.status, 'disabled');

    const restored = await person.call('PATCH', '/api/auth/preferences', { searchEnabled: true });
    assert.equal(restored.body.user.searchEnabled, true);
    await send(f, person);
    assert.equal(fetchImpl.calls.length, 2, 're-enabling restores the search behaviour');
});

test('the system prompt tells the model to flag volatile facts instead of inventing them', async context => {
    const f = await fixture(context);
    const person = f.employee('open_prompt_volatile');
    await send(f, person, '青禾精华现在多少钱？这个月还有名额吗？');
    const system = f.calls[0].filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.match(system, /需确认最新信息/);
    assert.match(system, /价格|政策|名额|库存|活动期限/);
    assert.match(system, /不掌握/);
});

test('the system prompt forbids invented file names and citations while allowing open answers', async context => {
    const f = await fixture(context);
    const person = f.employee('open_prompt_sources');
    await send(f, person);
    const system = f.calls[0].filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.match(system, /不要虚构文件名/);
    assert.match(system, /参考|引用编号/);
    assert.match(system, /没有资料时直接用常识和推理回答/);
    // Free mode also states the search capability honestly: with no provider configured the
    // model must not claim it browsed the web.
    assert.match(system, /没有联网或项目操作工具/);
});

test('the preferences endpoint still rejects unknown keys, empty bodies and non-boolean values', async context => {
    const f = await fixture(context);
    const person = f.employee('open_preferences_guard');
    for (const body of [{ systemRole: 'admin' }, {}, { searchEnabled: 'yes' }, { autoMemoryEnabled: 1 }, { unknown: true }]) {
        const response = await person.call('PATCH', '/api/auth/preferences', body);
        assert.equal(response.status, 400, JSON.stringify(body) + ' -> ' + JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'INVALID_PREFERENCES');
    }
    const both = await person.call('PATCH', '/api/auth/preferences', { autoMemoryEnabled: false, searchEnabled: false });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.user.autoMemoryEnabled, false);
    assert.equal(both.body.user.searchEnabled, false);
});

test('an existing database is migrated in place by adding the search preference column', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-search-migration-'));
    const file = path.join(directory, 'internal.sqlite');
    try {
        // A database created before R1-06: identical minus the new column.
        const legacy = new Database(file);
        legacy.exec(`CREATE TABLE users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            system_role TEXT NOT NULL DEFAULT 'member' CHECK(system_role IN ('admin','member')),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
            auto_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_memory_enabled IN (0,1)),
            mfa_secret TEXT, mfa_last_step INTEGER,
            deleted_at INTEGER CHECK(deleted_at IS NULL OR active=0),
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`);
        legacy.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,deleted_at,created_at,updated_at)
            VALUES('legacy-user','legacy','老账号','hash','member',NULL,1,1)`).run();
        legacy.close();

        const migrated = openDatabase(file);
        const column = migrated.prepare('PRAGMA table_info(users)').all().find(entry => entry.name === 'search_enabled');
        assert.ok(column, 'the migration must add users.search_enabled');
        assert.equal(column.notnull, 1);
        assert.equal(String(column.dflt_value), '1');
        // Existing rows keep working and default to "search allowed".
        assert.equal(migrated.prepare('SELECT search_enabled AS value FROM users WHERE id=?').get('legacy-user').value, 1);
        assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'no data loss');
        migrated.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
