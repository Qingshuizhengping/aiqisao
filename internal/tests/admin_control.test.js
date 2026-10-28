import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './helpers/application.js';
import { hashPassword } from '../lib/auth.js';
import { openDatabase } from '../lib/database.js';

async function passwordAccount(setup, username, role = 'member') {
    const person = setup.employee(username, role);
    setup.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('123456'), person.id);
    return person;
}

async function login(person, username) {
    const result = await person.call('POST', '/api/auth/login', { username, password: '123456' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    person.headers.Cookie = result.headers['set-cookie'][0].split(';')[0];
    person.headers['X-CSRF-Token'] = result.body.csrfToken;
    return result.body.user;
}

test('existing user databases gain deletion safeguards without changing passwords or original history', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-control-migration-'));
    const filename = path.join(directory, 'legacy.sqlite');
    let db = new Database(filename);
    context.after(() => {
        db.close();
        const target = path.resolve(directory);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('wzy-control-migration-'));
        fs.rmSync(target, { recursive: true, force: true });
    });
    db.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,system_role TEXT NOT NULL DEFAULT 'member' CHECK(system_role IN ('admin','member')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
        auto_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_memory_enabled IN (0,1)),mfa_secret TEXT,mfa_last_step INTEGER,
        created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
        project_id TEXT,title TEXT NOT NULL DEFAULT '新对话',memory_enabled INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL DEFAULT '',summary_message_id TEXT,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'complete',metadata TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
    const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
    const passwordHash = await hashPassword('123456');
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,system_role,mfa_secret,mfa_last_step) VALUES(?,?,?,?,?,?,?)')
        .run(userId, 'legacy-admin', 'Legacy administrator', passwordHash, 'admin', 'legacy-encrypted-fixture', 4321);
    db.prepare('INSERT INTO conversations(id,user_id,created_at,updated_at) VALUES(?,?,?,?)').run(conversationId, userId, 1700000000000, 1700000000000);
    db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at,updated_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, conversationId, 'Original pre-upgrade discussion', 1700000000000, 1700000000000);
    db.close();
    db = openDatabase(filename);
    const migrated = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    assert.equal(migrated.deleted_at, null);
    assert.equal(migrated.active, 1);
    assert.equal(migrated.password_hash, passwordHash);
    assert.equal(migrated.mfa_secret, 'legacy-encrypted-fixture');
    assert.equal(migrated.mfa_last_step, 4321);
    assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get(messageId).content, 'Original pre-upgrade discussion');
    assert.ok(db.prepare('PRAGMA index_list(users)').all().some(index => index.name === 'users_status'));
    assert.throws(() => db.prepare('UPDATE users SET deleted_at=? WHERE id=?').run(Date.now(), userId), /CHECK constraint/);
    db.prepare('UPDATE users SET active=0,deleted_at=? WHERE id=?').run(Date.now(), userId);
    assert.throws(() => db.prepare('UPDATE users SET active=1 WHERE id=?').run(userId), /CHECK constraint/);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash, passwordHash);
    assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get(messageId).content, 'Original pre-upgrade discussion');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('the control panel reports global counts while filtering accounts and excludes authentication secrets', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    const member = setup.employee('ordinary');
    const disabled = setup.employee('disabled');
    const deleted = setup.employee('deleted');
    setup.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('100% complete', member.id);
    setup.db.prepare('UPDATE users SET active=0 WHERE id=?').run(disabled.id);
    setup.db.prepare('UPDATE users SET active=0,deleted_at=? WHERE id=?').run(Date.now(), deleted.id);
    assert.equal((await admin.call('POST', '/api/projects', { name: 'Active project' })).status, 201);
    const archived = (await member.call('POST', '/api/projects', { name: 'Archived project' })).body.project;
    assert.equal((await member.call('PATCH', '/api/projects/' + archived.id, { archived: true })).status, 200);

    const all = await admin.call('GET', '/api/admin/control-panel?status=all');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.summary, { totalUsers: 5, activeUsers: 3, disabledUsers: 1, deletedUsers: 1,
        systemAdmins: 2, totalProjects: 2, activeProjects: 1, archivedProjects: 1 });
    assert.equal(all.body.users.length, 5);
    assert.equal(all.body.projects.length, 2);
    assert.equal(all.body.users.find(user => user.id === member.id).projectAdminCount, 1);
    assert.equal(all.body.users.find(user => user.id === member.id).memberships[0].projectId, archived.id);
    assert.ok(all.body.users.find(user => user.id === deleted.id).deletedAt);
    assert.doesNotMatch(JSON.stringify(all.body), /unused-test-password|password_hash|mfa_secret|pending_mfa_secret|csrf_token/);
    const current = await admin.call('GET', '/api/admin/control-panel');
    assert.equal(current.body.users.length, 4);
    assert.equal(current.body.users.some(user => user.id === deleted.id), false);
    const literal = await admin.call('GET', '/api/admin/control-panel?q=%25');
    assert.deepEqual(literal.body.users.map(user => user.id), [member.id]);
    assert.deepEqual(literal.body.summary, all.body.summary);
    const page = await admin.call('GET', '/api/admin/control-panel?status=all&limit=1&offset=1');
    assert.equal(page.body.users.length, 1);
    assert.equal(page.body.hasMore, true);
    for (const filter of ['status=unknown', 'systemRole=owner', 'limit=101', 'offset=-1']) {
        assert.equal((await admin.call('GET', '/api/admin/control-panel?' + filter)).status, 400);
    }
});

test('ordinary and project-admin accounts cannot open account control or promote themselves', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    const manager = setup.employee('project-manager');
    const member = setup.employee('ordinary');
    const project = (await manager.call('POST', '/api/projects', { name: 'Restricted controls' })).body.project;
    for (const person of [manager, member]) {
        assert.equal((await person.call('GET', '/api/admin/control-panel')).status, 403);
        assert.equal((await person.call('GET', '/api/admin/users')).status, 403);
        assert.equal((await person.call('GET', '/api/admin/users/' + person.id + '/projects')).status, 403);
        assert.equal((await person.call('PATCH', '/api/admin/users/' + person.id, { systemRole: 'admin' })).status, 403);
        assert.equal((await person.call('PUT', '/api/admin/users/' + person.id + '/projects/' + project.id, { role: 'admin' })).status, 403);
        assert.equal((await person.call('DELETE', '/api/admin/users/' + admin.id)).status, 403);
        assert.equal((await person.call('POST', '/api/admin/users/' + member.id + '/restore', {})).status, 403);
        assert.equal((await person.call('PATCH', '/api/auth/preferences', { systemRole: 'admin' })).status, 400);
        assert.equal(setup.db.prepare('SELECT system_role FROM users WHERE id=?').get(person.id).system_role, 'member');
    }
    setup.db.prepare("UPDATE users SET system_role='member' WHERE id=?").run(admin.id);
    assert.equal((await admin.call('GET', '/api/admin/control-panel')).status, 403);
    assert.equal((await admin.call('PATCH', '/api/admin/users/' + member.id, { active: false })).status, 403);
    assert.equal(setup.db.prepare('SELECT active FROM users WHERE id=?').get(member.id).active, 1);
});

test('soft deletion revokes sessions and preserves original chats and memories; restoration remains disabled until reviewed', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    const member = await passwordAccount(setup, 'former-employee');
    const otherLogin = await login(member, 'former-employee');
    assert.equal(otherLogin.mfaRequired, false);
    const oldCookie = member.headers.Cookie;
    const conversation = await setup.conversation(member);
    const messageId = randomUUID();
    setup.db.prepare("INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,'user',?,'complete',?,?)")
        .run(messageId, conversation.id, 'Original employee discussion retained for audit', Date.now(), Date.now());
    const memory = (await member.call('POST', '/api/memories', { scope: 'personal', content: '原有工作记忆需要保留以便审计。' })).body.memory;

    const removed = await admin.call('DELETE', '/api/admin/users/' + member.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const row = setup.db.prepare('SELECT * FROM users WHERE id=?').get(member.id);
    assert.equal(row.active, 0);
    assert.ok(row.deleted_at > 0);
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(member.id).count, 0);
    assert.equal((await member.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await member.call('POST', '/api/auth/login', { username: 'former-employee', password: '123456' })).status, 401);
    assert.equal(setup.db.prepare('SELECT content FROM messages WHERE id=?').get(messageId).content, 'Original employee discussion retained for audit');
    assert.equal(setup.db.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content, '原有工作记忆需要保留以便审计。');
    const audit = await admin.call('GET', '/api/admin/audit/conversations/' + conversation.id);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.messages[0].id, messageId);
    assert.equal((await admin.call('PATCH', '/api/admin/users/' + member.id, { active: true })).status, 409);
    assert.equal((await admin.call('POST', '/api/admin/users/' + member.id + '/reset-password', { password: '654321' })).status, 409);
    assert.equal((await admin.call('POST', '/api/admin/users', { username: 'former-employee', displayName: 'Replacement', password: '123456' })).status, 409);

    const restored = await admin.call('POST', '/api/admin/users/' + member.id + '/restore', {});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.user.active, false);
    assert.equal(restored.body.user.deletedAt, null);
    assert.equal((await member.call('POST', '/api/auth/login', { username: 'former-employee', password: '123456' })).status, 401);
    assert.equal((await admin.call('POST', '/api/admin/users/' + member.id + '/restore', {})).status, 409);
    assert.equal((await admin.call('PATCH', '/api/admin/users/' + member.id, { active: true })).status, 200);
    assert.equal((await member.call('GET', '/api/auth/me', undefined, { Cookie: oldCookie })).status, 401);
    await login(member, 'former-employee');
    assert.equal((await member.call('GET', '/api/conversations/' + conversation.id)).status, 200);
    const actions = setup.db.prepare('SELECT action FROM audit_records WHERE target_id=?').all(member.id).map(record => record.action);
    assert.ok(actions.some(action => /delete/.test(action)));
    assert.ok(actions.some(action => /restore/.test(action)));
});

test('self removal and removal of an active project sole administrator are blocked until handover', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    for (const [method, body] of [['DELETE', undefined], ['PATCH', { active: false }], ['PATCH', { systemRole: 'member' }]]) {
        const result = await admin.call(method, '/api/admin/users/' + admin.id, body);
        assert.equal(result.status, 409);
        assert.equal(result.body.error.code, 'SELF_ADMIN_PROTECTED');
    }
    const owner = setup.employee('project-owner');
    const inactive = setup.employee('inactive-backup');
    const project = (await owner.call('POST', '/api/projects', { name: 'Continuity required' })).body.project;
    setup.db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,'admin',?)").run(project.id, inactive.id, Date.now());
    setup.db.prepare('UPDATE users SET active=0 WHERE id=?').run(inactive.id);
    for (const [method, body] of [['DELETE', undefined], ['PATCH', { active: false }]]) {
        const result = await admin.call(method, '/api/admin/users/' + owner.id, body);
        assert.equal(result.status, 409);
        assert.equal(result.body.error.code, 'LAST_PROJECT_ADMIN');
    }
    assert.equal((await admin.call('PUT', '/api/admin/users/' + inactive.id + '/projects/' + project.id, { role: 'admin' })).status, 409);
    assert.equal((await admin.call('PUT', '/api/admin/users/' + admin.id + '/projects/' + project.id, { role: 'admin' })).status, 200);
    assert.equal((await admin.call('DELETE', '/api/admin/users/' + owner.id)).status, 200);
    assert.equal(setup.db.prepare('SELECT active FROM users WHERE id=?').get(admin.id).active, 1);
    assert.equal(setup.db.prepare('SELECT deleted_at FROM users WHERE id=?').get(admin.id).deleted_at, null);
});

test('central project grants and revocations change only explicit project access and retain private library isolation', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    const owner = setup.employee('project-owner');
    const member = await passwordAccount(setup, 'assigned-member');
    const first = (await owner.call('POST', '/api/projects', { name: 'First project' })).body.project;
    const second = (await owner.call('POST', '/api/projects', { name: 'Second project' })).body.project;
    const projectConversation = await setup.conversation(owner, first.id);
    const privateConversation = await setup.conversation(owner);
    await owner.call('POST', '/api/memories', { scope: 'project_private', projectId: first.id, content: '负责人在该项目里的私人工作记忆。' });
    await owner.call('POST', '/api/memories', { scope: 'personal', content: '负责人的跨项目私人记忆。' });
    const before = await admin.call('GET', '/api/admin/users/' + member.id + '/projects');
    assert.equal(before.status, 200);
    assert.equal(before.body.projects.length, 2);
    assert.equal(before.body.projects.find(project => project.id === first.id).role, null);
    assert.equal((await admin.call('GET', '/api/projects')).body.projects.length, 0);
    assert.doesNotMatch(JSON.stringify((await admin.call('GET', '/api/admin/control-panel')).body), /私人工作记忆|跨项目私人记忆/);
    assert.equal((await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + first.id, { role: 'system_admin' })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + first.id, { role: 'member' })).status, 200);
    await login(member, 'assigned-member');
    assert.deepEqual((await member.call('GET', '/api/projects')).body.projects.map(project => project.id), [first.id]);
    assert.equal((await member.call('PATCH', '/api/projects/' + first.id, { name: 'Not allowed' })).status, 403);
    assert.equal((await member.call('GET', '/api/conversations/' + projectConversation.id)).status, 403);
    assert.equal((await member.call('GET', '/api/projects/' + second.id + '/members')).status, 403);

    assert.equal((await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + first.id, { role: 'admin' })).status, 200);
    await login(member, 'assigned-member');
    assert.equal((await member.call('PATCH', '/api/projects/' + first.id, { name: 'Explicit administrator grant' })).status, 200);
    const colleague = await member.call('GET', '/api/conversations/' + projectConversation.id);
    assert.equal(colleague.status, 200);
    assert.equal(colleague.body.conversation.readOnly, true);
    assert.equal((await member.call('GET', '/api/conversations/' + privateConversation.id)).status, 403);
    assert.equal((await member.call('GET', '/api/memories?scope=project_private&projectId=' + first.id)).body.memories.length, 0);
    assert.equal((await member.call('GET', '/api/memories?scope=personal')).body.memories.length, 0);
    assert.equal((await admin.call('GET', '/api/projects')).body.projects.length, 0);

    assert.equal((await admin.call('DELETE', '/api/admin/users/' + member.id + '/projects/' + first.id)).status, 200);
    await login(member, 'assigned-member');
    assert.equal((await member.call('GET', '/api/projects')).body.projects.length, 0);
    assert.equal((await member.call('GET', '/api/conversations/' + projectConversation.id)).status, 403);
    assert.equal((await member.call('GET', '/api/projects/' + first.id + '/members')).status, 403);
    const after = await admin.call('GET', '/api/admin/users/' + member.id + '/projects');
    assert.equal(after.body.projects.find(project => project.id === first.id).role, null);
    assert.equal((await admin.call('GET', '/api/admin/users')).body.users.find(user => user.id === member.id).projectCount, 0);
});

test('deleted accounts cannot receive project grants and archived project membership remains read-only', async context => {
    const setup = await fixture(context);
    const admin = setup.employee('control-admin', 'admin');
    const member = setup.employee('ordinary');
    const project = (await admin.call('POST', '/api/projects', { name: 'Archived access' })).body.project;
    assert.equal((await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + project.id, { role: 'member' })).status, 200);
    assert.equal((await admin.call('PATCH', '/api/projects/' + project.id, { archived: true })).status, 200);
    assert.equal((await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + project.id, { role: 'admin' })).status, 409);
    assert.equal((await admin.call('DELETE', '/api/admin/users/' + member.id + '/projects/' + project.id)).status, 409);
    assert.equal((await admin.call('DELETE', '/api/admin/users/' + member.id)).status, 200);
    const denied = await admin.call('PUT', '/api/admin/users/' + member.id + '/projects/' + project.id, { role: 'member' });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'USER_DELETED');
});
