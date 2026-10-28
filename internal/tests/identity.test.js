import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { openDatabase } from '../lib/database.js';
import { createAuth, hashPassword, validatePassword } from '../lib/auth.js';
import { audit, projectRole, publicUser, requireProjectAdmin } from '../lib/access.js';
import { createProjectsRouter } from '../lib/projects.js';
import { createAdminRouter } from '../lib/admin.js';
import { AppError } from '../lib/errors.js';

const origin = 'https://internal.test';
const initialPassword = 'InitialPassword2026!';
const changedPassword = 'ChangedPassword2026!';

test('password policy accepts six numeric characters while hashing with fresh salts and rejecting short or invalid values', async () => {
    assert.equal(validatePassword('123456'), '123456');
    assert.equal(validatePassword('abcdef'), 'abcdef');
    assert.equal(validatePassword('123456789012'), '123456789012');
    for (const value of ['12345', '', null, 123456, 'a'.repeat(257)]) {
        assert.throws(() => validatePassword(value), error => error instanceof AppError && error.status === 400 && error.code === 'INVALID_PASSWORD');
    }
    const first = await hashPassword('123456');
    const second = await hashPassword('123456');
    assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.notEqual(first, second);
    assert.notEqual(first, '123456');
});

async function fixture(context) {
    const db = openDatabase(':memory:');
    const config = { origin, secureCookies: false, cookieName: 'test_internal', sessionTtlMs: 3600000,
        encryptionKey: Buffer.alloc(32, 7), bootstrapUsername: 'admin', bootstrapPassword: initialPassword };
    const auth = createAuth({ db, config });
    await auth.bootstrap();
    const app = express();
    app.use(express.json());
    app.use(auth.guardOrigin);
    app.use('/api/auth', auth.router);
    app.get('/api/workspace', auth.requireReadyUser, (request, response) => response.json({ user: request.user }));
    app.use('/api/projects', auth.requireReadyUser, createProjectsRouter({ db }));
    app.use('/api/admin', auth.requireReadyUser, createAdminRouter({ db, auth }));
    app.use((error, request, response, next) => response.status(error instanceof AppError ? error.status : 500)
        .json({ error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : 'Internal error' } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    context.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        db.close();
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    function client() {
        let cookie = '';
        let csrf = '';
        return {
            async call(method, route, data, options = {}) {
                const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'X-CSRF-Token': csrf }), ...options.headers };
                if (data !== undefined) headers['Content-Type'] = 'application/json';
                const response = await fetch(base + route, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
                const setCookie = response.headers.get('set-cookie');
                if (setCookie) cookie = setCookie.split(';')[0];
                let body;
                try { body = await response.json(); } catch { body = null; }
                if (body?.csrfToken) csrf = body.csrfToken;
                return { status: response.status, body, headers: response.headers };
            },
            get cookie() { return cookie; },
            get csrf() { return csrf; },
        };
    }
    async function enroll(person) {
        const setup = await person.call('POST', '/api/auth/mfa/setup', { password: changedPassword });
        assert.equal(setup.status, 200);
        const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret), period: 30, digits: 6 });
        assert.equal((await person.call('POST', '/api/auth/mfa/confirm', { code: totp.generate() })).status, 200);
        return { totp, secret: setup.body.secret };
    }
    async function readyAdmin() {
        const admin = client();
        assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword })).status, 200);
        assert.equal((await admin.call('POST', '/api/auth/password', { currentPassword: initialPassword, newPassword: changedPassword })).status, 200);
        return { client: admin, ...await enroll(admin) };
    }
    async function employee(admin, username = 'employee') {
        const created = await admin.call('POST', '/api/admin/users', { username, displayName: username, password: initialPassword });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const person = client();
        assert.equal((await person.call('POST', '/api/auth/login', { username, password: initialPassword })).status, 200);
        assert.equal((await person.call('POST', '/api/auth/password', { currentPassword: initialPassword, newPassword: changedPassword })).status, 200);
        return { client: person, user: created.body.user };
    }
    return { db, auth, config, client, readyAdmin, employee, enroll };
}

test('bootstrap creates one restricted admin, passwords and session tokens are never stored in plaintext', async context => {
    const setup = await fixture(context);
    const admin = setup.client();
    const login = await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePassword, true);
    assert.equal(login.body.user.mfaEnabled, false);
    assert.equal(login.body.user.passwordHash, undefined);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    const row = setup.db.prepare('SELECT * FROM users').get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(row.password_hash.includes(initialPassword), false);
    assert.equal((await admin.call('GET', '/api/workspace')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(await setup.auth.bootstrap(), false);
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    const session = setup.db.prepare('SELECT * FROM sessions').get();
    assert.equal(session.id.includes(admin.cookie.split('=')[1]), false);
});

test('unsafe requests reject wrong origins and missing CSRF before changing authentication state', async context => {
    const setup = await fixture(context);
    const admin = setup.client();
    assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword }, { headers: { Origin: 'https://public.test' } })).status, 403);
    assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword })).status, 200);
    const denied = await admin.call('POST', '/api/auth/password', { currentPassword: initialPassword, newPassword: changedPassword }, { headers: { 'X-CSRF-Token': '' } });
    assert.equal(denied.body.error.code, 'CSRF_INVALID');
    assert.equal(setup.db.prepare('SELECT must_change_password FROM users').get().must_change_password, 1);
});

test('expired, duplicate and logged-out session cookies cannot read authenticated state', async context => {
    const setup = await fixture(context);
    const admin = setup.client();
    const login = await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
    assert.equal(login.headers.get('set-cookie').includes('Domain='), false);
    const cookie = admin.cookie;
    assert.equal((await admin.call('GET', '/api/auth/me', undefined, { headers: { Cookie: cookie + '; ' + cookie } })).status, 401);
    setup.db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() - 1);
    assert.equal((await admin.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword })).status, 200);
    const freshCookie = admin.cookie;
    const logout = await admin.call('POST', '/api/auth/logout');
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await admin.call('GET', '/api/auth/me', undefined, { headers: { Cookie: freshCookie } })).status, 401);
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('admin password change and verified TOTP enrollment rotate sessions and unlock the workspace', async context => {
    const setup = await fixture(context);
    const admin = setup.client();
    await admin.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
    const oldCookie = admin.cookie;
    await admin.call('POST', '/api/auth/password', { currentPassword: initialPassword, newPassword: changedPassword });
    assert.notEqual(admin.cookie, oldCookie);
    assert.equal((await admin.call('GET', '/api/workspace')).body.error.code, 'MFA_SETUP_REQUIRED');
    const enrollment = await admin.call('POST', '/api/auth/mfa/setup', { password: changedPassword });
    assert.match(enrollment.body.uri, /^otpauth:\/\/totp\//);
    const pending = setup.db.prepare('SELECT pending_mfa_secret FROM sessions').get().pending_mfa_secret;
    assert.equal(pending.includes(enrollment.body.secret), false);
    assert.equal((await admin.call('POST', '/api/auth/mfa/confirm', { code: 'invalid' })).status, 400);
    assert.equal(setup.db.prepare('SELECT mfa_secret FROM users').get().mfa_secret, null);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrollment.body.secret) });
    const confirmation = await admin.call('POST', '/api/auth/mfa/confirm', { code: totp.generate() });
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.body.user.mfaEnabled, true);
    assert.equal((await admin.call('GET', '/api/workspace')).status, 200);
    assert.equal(setup.db.prepare('SELECT mfa_secret FROM users').get().mfa_secret.includes(enrollment.body.secret), false);
});

test('enrolled admin login requires a fresh TOTP and rejects replayed codes', async context => {
    const setup = await fixture(context);
    const ready = await setup.readyAdmin();
    const other = setup.client();
    assert.equal((await other.call('POST', '/api/auth/login', { username: 'admin', password: changedPassword })).status, 401);
    assert.equal((await other.call('POST', '/api/auth/login', { username: 'admin', password: changedPassword, totp: ready.totp.generate() })).status, 401);
    const fresh = ready.totp.generate({ timestamp: Date.now() + 30000 });
    assert.equal((await other.call('POST', '/api/auth/login', { username: 'admin', password: changedPassword, totp: fresh })).status, 200);
    const replay = setup.client();
    assert.equal((await replay.call('POST', '/api/auth/login', { username: 'admin', password: changedPassword, totp: fresh })).status, 401);
});

test('unknown users and wrong passwords share generic errors and login attempts are bounded', async context => {
    const setup = await fixture(context);
    const client = setup.client();
    const unknown = await client.call('POST', '/api/auth/login', { username: 'nobody', password: initialPassword });
    const wrong = await client.call('POST', '/api/auth/login', { username: 'admin', password: changedPassword });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
    for (let attempt = 0; attempt < 7; attempt++) await client.call('POST', '/api/auth/login', { username: 'nobody', password: initialPassword });
    assert.equal((await client.call('POST', '/api/auth/login', { username: 'nobody', password: initialPassword })).status, 429);
    for (let attempt = 0; attempt < 21; attempt++) await client.call('POST', '/api/auth/login', { username: 'different' + attempt, password: initialPassword });
    assert.equal((await client.call('POST', '/api/auth/login', { username: 'admin', password: initialPassword })).status, 429);
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('employee account setup requires a changed password and does not grant admin authority', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const created = await admin.client.call('POST', '/api/admin/users', { username: 'alice', displayName: 'Alice', password: initialPassword });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.mustChangePassword, true);
    const alice = setup.client();
    await alice.call('POST', '/api/auth/login', { username: 'alice', password: initialPassword });
    assert.equal((await alice.call('GET', '/api/projects')).status, 428);
    await alice.call('POST', '/api/auth/password', { currentPassword: initialPassword, newPassword: changedPassword });
    assert.equal((await alice.call('GET', '/api/workspace')).status, 200);
    assert.equal((await alice.call('GET', '/api/admin/users')).status, 403);
    assert.equal((await alice.call('POST', '/api/auth/mfa/setup', { password: changedPassword })).status, 403);
    assert.equal((await alice.call('PATCH', '/api/auth/preferences', { autoMemoryEnabled: false })).body.user.autoMemoryEnabled, false);
    assert.equal((await alice.call('PATCH', '/api/auth/preferences', { systemRole: 'admin' })).status, 400);
});

test('project admins manage only their own memberships and system audit role is not implicit project membership', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    const bob = await setup.employee(admin.client, 'bobby');
    const created = await alice.client.call('POST', '/api/projects', { name: 'Launch', instructions: 'Keep clear records' });
    assert.equal(created.status, 201);
    const project = created.body.project;
    assert.equal(project.role, 'admin');
    assert.equal((await alice.client.call('GET', '/api/auth/me')).body.user.mfaRequired, true);
    assert.equal((await alice.client.call('GET', '/api/projects')).body.error.code, 'MFA_SETUP_REQUIRED');
    await setup.enroll(alice.client);
    assert.equal((await admin.client.call('GET', '/api/projects')).body.projects.length, 0);
    assert.equal((await admin.client.call('PATCH', '/api/projects/' + project.id, { name: 'No' })).status, 403);
    assert.equal((await bob.client.call('GET', '/api/projects/' + project.id + '/members')).status, 403);
    assert.equal((await alice.client.call('PUT', '/api/projects/' + project.id + '/members/' + bob.user.id, { role: 'member' })).status, 200);
    assert.equal((await bob.client.call('GET', '/api/projects')).body.projects[0].id, project.id);
    assert.equal((await bob.client.call('PATCH', '/api/projects/' + project.id, { name: 'No' })).status, 403);
    assert.equal((await alice.client.call('PUT', '/api/projects/' + project.id + '/members/' + alice.user.id, { role: 'member' })).body.error.code, 'LAST_PROJECT_ADMIN');
    assert.equal((await alice.client.call('PUT', '/api/projects/' + project.id + '/members/' + bob.user.id, { role: 'admin' })).status, 200);
    assert.equal((await bob.client.call('GET', '/api/projects')).body.error.code, 'MFA_SETUP_REQUIRED');
    await setup.enroll(bob.client);
    assert.equal((await alice.client.call('PUT', '/api/projects/' + project.id + '/members/' + alice.user.id, { role: 'member' })).status, 200);
    assert.equal((await alice.client.call('PATCH', '/api/projects/' + project.id, { name: 'No' })).status, 403);
    assert.equal((await bob.client.call('DELETE', '/api/projects/' + project.id + '/members/' + alice.user.id)).status, 200);
    assert.equal((await alice.client.call('GET', '/api/projects')).body.projects.length, 0);
    assert.equal(projectRole(setup.db, { id: alice.user.id }, project.id), null);
});

test('archive is read-only until explicitly restored and final project admin cannot be removed', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const created = await admin.client.call('POST', '/api/projects', { name: 'Archive' });
    const id = created.body.project.id;
    const adminId = (await admin.client.call('GET', '/api/auth/me')).body.user.id;
    assert.equal((await admin.client.call('DELETE', '/api/projects/' + id + '/members/' + adminId)).status, 409);
    assert.equal((await admin.client.call('PATCH', '/api/projects/' + id, { archived: true })).status, 200);
    assert.equal((await admin.client.call('PATCH', '/api/projects/' + id, { name: 'No' })).status, 409);
    assert.equal((await admin.client.call('PUT', '/api/projects/' + id + '/members/' + adminId, { role: 'admin' })).status, 409);
    assert.equal((await admin.client.call('PATCH', '/api/projects/' + id, { archived: false })).status, 200);
    assert.equal((await admin.client.call('PATCH', '/api/projects/' + id, { name: 'Restored' })).body.project.name, 'Restored');
});

test('account disable and role changes revoke sessions immediately and cannot remove the acting admin', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    const project = await alice.client.call('POST', '/api/projects', { name: 'Continuity protected' });
    await setup.enroll(alice.client);
    assert.equal((await admin.client.call('PATCH', '/api/admin/users/' + alice.user.id, { active: false })).body.error.code, 'LAST_PROJECT_ADMIN');
    await alice.client.call('PATCH', '/api/projects/' + project.body.project.id, { archived: true });
    assert.equal((await admin.client.call('PATCH', '/api/admin/users/' + alice.user.id, { active: false })).status, 200);
    assert.equal((await alice.client.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await alice.client.call('POST', '/api/auth/login', { username: 'alice', password: changedPassword })).status, 401);
    const ownId = (await admin.client.call('GET', '/api/auth/me')).body.user.id;
    assert.equal((await admin.client.call('PATCH', '/api/admin/users/' + ownId, { active: false })).status, 409);
    assert.equal((await admin.client.call('PATCH', '/api/admin/users/' + ownId, { systemRole: 'member' })).status, 409);
    await admin.client.call('PATCH', '/api/admin/users/' + alice.user.id, { active: true });
    const bob = await setup.employee(admin.client, 'bobby');
    assert.equal((await admin.client.call('PATCH', '/api/admin/users/' + bob.user.id, { systemRole: 'admin' })).status, 200);
    assert.equal((await bob.client.call('GET', '/api/auth/me')).status, 401);
    await bob.client.call('POST', '/api/auth/login', { username: 'bobby', password: changedPassword });
    assert.equal((await bob.client.call('GET', '/api/workspace')).body.error.code, 'MFA_SETUP_REQUIRED');
});

test('password reset invalidates every employee session and requires a new password before workspace access', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    const other = setup.client();
    await other.call('POST', '/api/auth/login', { username: 'alice', password: changedPassword });
    const reset = await admin.client.call('POST', '/api/admin/users/' + alice.user.id + '/reset-password', { password: 'ResetPassword2026!' });
    assert.equal(reset.status, 200);
    assert.equal((await alice.client.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await other.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await alice.client.call('POST', '/api/auth/login', { username: 'alice', password: 'ResetPassword2026!' })).body.user.mustChangePassword, true);
    assert.equal((await alice.client.call('GET', '/api/projects')).status, 428);
});

test('global audit reads private conversations but offers no mutation or normal project privileges', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const time = Date.now();
    setup.db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(conversationId, alice.user.id, 'Private work', time, time);
    setup.db.prepare('INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(messageId, conversationId, 'user', 'A private project detail', 'complete', time, time);
    const list = await admin.client.call('GET', '/api/admin/audit/conversations?q=private');
    assert.equal(list.status, 200);
    assert.equal(list.body.conversations[0].readOnly, true);
    const read = await admin.client.call('GET', '/api/admin/audit/conversations/' + conversationId);
    assert.equal(read.status, 200);
    assert.equal(read.body.messages[0].content, 'A private project detail');
    assert.equal(read.body.conversation.readOnly, true);
    assert.equal((await alice.client.call('GET', '/api/admin/audit/conversations')).status, 403);
    assert.equal((await admin.client.call('PATCH', '/api/admin/audit/conversations/' + conversationId, { title: 'Changed' })).status, 404);
    assert.equal(setup.db.prepare('SELECT title FROM conversations WHERE id=?').get(conversationId).title, 'Private work');
    assert.ok(setup.db.prepare("SELECT id FROM audit_records WHERE action='audit.conversation_read' AND target_id=?").get(conversationId));
    const events = await admin.client.call('GET', '/api/admin/audit/events');
    assert.equal(events.status, 200);
    assert.equal(JSON.stringify(events.body).includes('A private project detail'), false);
});

test('memory audit sees all live scopes while remaining read-only and suppressing deleted content', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    setup.db.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY,scope TEXT,user_id TEXT,project_id TEXT,content TEXT,status TEXT,
        source_conversation_id TEXT,source_message_id TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER)`);
    const time = Date.now();
    setup.db.prepare('INSERT INTO memories(id,scope,user_id,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), 'personal', alice.user.id, 'Private memory', 'active', time, time);
    setup.db.prepare('INSERT INTO memories(id,scope,user_id,content,status,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(), 'personal', alice.user.id, 'Deleted memory', 'deleted', time, time, time);
    const result = await admin.client.call('GET', '/api/admin/audit/memories?userId=' + alice.user.id);
    assert.equal(result.status, 200);
    assert.equal(result.body.memories.length, 1);
    assert.equal(result.body.memories[0].content, 'Private memory');
    assert.equal(result.body.memories[0].canEdit, false);
    assert.equal(result.body.memories[0].canReview, false);
    assert.equal((await alice.client.call('GET', '/api/admin/audit/memories')).status, 403);
});

test('global conversation audit retains soft-deleted original chats and all saved message states', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const alice = await setup.employee(admin.client, 'alice');
    const id = randomUUID();
    const time = Date.now();
    setup.db.prepare('INSERT INTO conversations(id,user_id,title,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(id, alice.user.id, 'Removed from personal list', time, time - 100, time);
    const insert = setup.db.prepare('INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    insert.run(randomUUID(), id, 'user', 'Original employee question', 'complete', time - 80, time - 80);
    insert.run(randomUUID(), id, 'assistant', 'Partial saved answer', 'interrupted', time - 60, time - 40);
    const list = await admin.client.call('GET', '/api/admin/audit/conversations');
    assert.equal(list.body.conversations.length, 1);
    assert.equal(list.body.conversations[0].deletedAt, time);
    const read = await admin.client.call('GET', '/api/admin/audit/conversations/' + id);
    assert.equal(read.status, 200);
    assert.equal(read.body.conversation.deletedAt, time);
    assert.deepEqual(read.body.messages.map(message => [message.content, message.status]), [
        ['Original employee question', 'complete'], ['Partial saved answer', 'interrupted'],
    ]);
});

test('audit filters enforce inclusive time boundaries, literal search and bounded pagination', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const ownerId = (await admin.client.call('GET', '/api/auth/me')).body.user.id;
    const insert = setup.db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)');
    const base = 1700000000000;
    for (const [index, title] of ['Before', '100% complete', 'Boundary', 'After'].entries()) {
        insert.run(randomUUID(), ownerId, title, base + index, base + index);
    }
    const range = await admin.client.call('GET', '/api/admin/audit/conversations?from=' + (base + 1) + '&to=' + encodeURIComponent(new Date(base + 2).toISOString()));
    assert.deepEqual(range.body.conversations.map(row => row.title), ['Boundary', '100% complete']);
    const literal = await admin.client.call('GET', '/api/admin/audit/conversations?q=%25');
    assert.deepEqual(literal.body.conversations.map(row => row.title), ['100% complete']);
    const page = await admin.client.call('GET', '/api/admin/audit/conversations?limit=1&offset=1');
    assert.equal(page.body.conversations[0].title, 'Boundary');
    assert.equal((await admin.client.call('GET', '/api/admin/audit/conversations?from=10&to=1')).status, 400);
    assert.equal((await admin.client.call('GET', '/api/admin/audit/events?from=invalid')).status, 400);
    assert.equal((await admin.client.call('GET', '/api/admin/audit/conversations?limit=101')).status, 400);
});

test('audit details exclude secrets and project access checks re-read current account activity', async context => {
    const setup = await fixture(context);
    const row = setup.db.prepare('SELECT * FROM users').get();
    const actor = publicUser(row);
    audit(setup.db, actor, 'test', 'user', actor.id, { password: 'never', content: 'never', token: 'never', rawQuery: 'never', count: 3, role: 'member' });
    const details = JSON.parse(setup.db.prepare("SELECT details FROM audit_records WHERE action='test'").get().details);
    assert.deepEqual(details, { count: 3, role: 'member' });
    const projectId = randomUUID();
    const time = Date.now();
    setup.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run(projectId, 'Test', actor.id, time, time);
    setup.db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)').run(projectId, actor.id, 'admin', time);
    assert.throws(() => requireProjectAdmin(setup.db, actor, projectId), error => error.code === 'PASSWORD_CHANGE_REQUIRED');
    setup.db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(actor.id);
    assert.throws(() => requireProjectAdmin(setup.db, actor, projectId), error => error.code === 'MFA_SETUP_REQUIRED');
    setup.db.prepare("UPDATE users SET mfa_secret='fixture-enrolled' WHERE id=?").run(actor.id);
    assert.equal(requireProjectAdmin(setup.db, actor, projectId), 'admin');
    setup.db.prepare('UPDATE users SET active=0 WHERE id=?').run(actor.id);
    assert.equal(projectRole(setup.db, actor, projectId), null);
});

test('six-digit numeric passwords work for account creation, first setup, ordinary changes and administrator reset', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const existingHash = setup.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash;
    const created = await admin.client.call('POST', '/api/admin/users', { username: 'numeric_member', displayName: 'Numeric Member', password: '123456' });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.password, undefined);
    assert.equal(created.body.user.passwordHash, undefined);
    const id = created.body.user.id;
    assert.match(setup.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash, /^scrypt\$/);
    const person = setup.client();
    const firstLogin = await person.call('POST', '/api/auth/login', { username: 'numeric_member', password: '123456' });
    assert.equal(firstLogin.status, 200);
    assert.equal(firstLogin.body.user.mustChangePassword, true);
    const firstChange = await person.call('POST', '/api/auth/password', { currentPassword: '123456', newPassword: '654321' });
    assert.equal(firstChange.status, 200);
    assert.equal(firstChange.body.user.mustChangePassword, false);
    assert.equal(firstChange.body.user.passwordHash, undefined);
    assert.equal((await person.call('GET', '/api/workspace')).status, 200);
    const another = setup.client();
    assert.equal((await another.call('POST', '/api/auth/login', { username: 'numeric_member', password: '654321' })).status, 200);
    assert.equal((await person.call('POST', '/api/auth/password', { currentPassword: '654321', newPassword: '112233' })).status, 200);
    assert.equal((await another.call('GET', '/api/workspace')).status, 401);
    assert.equal((await another.call('POST', '/api/auth/login', { username: 'numeric_member', password: '112233' })).status, 200);
    const reset = await admin.client.call('POST', '/api/admin/users/' + id + '/reset-password', { password: '445566' });
    assert.equal(reset.status, 200);
    assert.equal((await person.call('GET', '/api/workspace')).status, 401);
    assert.equal((await another.call('GET', '/api/workspace')).status, 401);
    const resetLogin = await person.call('POST', '/api/auth/login', { username: 'numeric_member', password: '445566' });
    assert.equal(resetLogin.status, 200);
    assert.equal(resetLogin.body.user.mustChangePassword, true);
    assert.equal((await person.call('POST', '/api/auth/password', { currentPassword: '445566', newPassword: '778899' })).status, 200);
    assert.equal((await setup.client().call('POST', '/api/auth/login', { username: 'numeric_member', password: '778899' })).status, 200);
    assert.equal(await setup.auth.bootstrap(), false);
    assert.equal(setup.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash, existingHash);
});

test('five-character passwords are rejected by creation, change and reset APIs without changing hashes or sessions', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const rejected = await admin.client.call('POST', '/api/admin/users', { username: 'too_short', displayName: 'Short', password: '12345' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'INVALID_PASSWORD');
    assert.equal(setup.db.prepare("SELECT COUNT(*) AS count FROM users WHERE username='too_short'").get().count, 0);
    const created = await admin.client.call('POST', '/api/admin/users', { username: 'numeric_member', displayName: 'Numeric', password: '123456' });
    const id = created.body.user.id;
    const person = setup.client();
    await person.call('POST', '/api/auth/login', { username: 'numeric_member', password: '123456' });
    const originalHash = setup.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash;
    const change = await person.call('POST', '/api/auth/password', { currentPassword: '123456', newPassword: '12345' });
    assert.equal(change.status, 400);
    assert.equal(change.body.error.code, 'INVALID_PASSWORD');
    const reset = await admin.client.call('POST', '/api/admin/users/' + id + '/reset-password', { password: '12345' });
    assert.equal(reset.status, 400);
    assert.equal(reset.body.error.code, 'INVALID_PASSWORD');
    assert.equal(setup.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash, originalHash);
    assert.equal((await person.call('GET', '/api/auth/me')).status, 200);
    assert.equal(setup.db.prepare('SELECT must_change_password FROM users WHERE id=?').get(id).must_change_password, 1);
});

test('numeric administrator passwords still require first-login change and verified TOTP', async context => {
    const setup = await fixture(context);
    const admin = await setup.readyAdmin();
    const created = await admin.client.call('POST', '/api/admin/users', { username: 'numeric_admin', displayName: 'Numeric Admin', systemRole: 'admin', password: '123456' });
    assert.equal(created.status, 201);
    const person = setup.client();
    assert.equal((await person.call('POST', '/api/auth/login', { username: 'numeric_admin', password: '123456' })).status, 200);
    assert.equal((await person.call('GET', '/api/workspace')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await person.call('POST', '/api/auth/password', { currentPassword: '123456', newPassword: '654321' })).status, 200);
    assert.equal((await person.call('GET', '/api/workspace')).body.error.code, 'MFA_SETUP_REQUIRED');
    const enrollment = await person.call('POST', '/api/auth/mfa/setup', { password: '654321' });
    assert.equal(enrollment.status, 200);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrollment.body.secret) });
    assert.equal((await person.call('POST', '/api/auth/mfa/confirm', { code: totp.generate() })).status, 200);
    assert.equal((await person.call('GET', '/api/workspace')).status, 200);
    const other = setup.client();
    assert.equal((await other.call('POST', '/api/auth/login', { username: 'numeric_admin', password: '654321' })).status, 401);
    assert.equal((await other.call('POST', '/api/auth/login', { username: 'numeric_admin', password: '654321', totp: totp.generate({ timestamp: Date.now() + 30000 }) })).status, 200);
});
