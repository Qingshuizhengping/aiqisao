import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fixture, eventually } from './helpers/application.js';

// ---------------------------------------------------------------- helpers

/** Creates a project owned (and administered) by `client`. */
async function project(client, name) {
    const response = await client.call('POST', '/api/projects', { name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.project;
}

/** Adds an existing account to a project with the given role. */
async function addMember(manager, projectId, client, role = 'member') {
    const response = await manager.call('PUT', '/api/projects/' + projectId + '/members/' + client.id, { role });
    assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function share(manager, projectId, shared = true) {
    const response = await manager.call('PATCH', '/api/projects/' + projectId, { shared });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.project;
}

/** Issues a brand new session for an existing account (used after a forced logout). */
function relogin(f, client) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = Date.now();
    f.db.prepare('INSERT INTO sessions(id,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), client.id, csrf, now, now + 3600000);
    client.headers.Cookie = f.config.cookieName + '=' + token;
    client.headers['X-CSRF-Token'] = csrf;
    return client;
}

function memberRow(f, projectId, userId) {
    return f.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, userId);
}

function audits(f, action) {
    return f.db.prepare('SELECT details FROM audit_records WHERE action=? ORDER BY created_at,id').all(action)
        .map(row => JSON.parse(row.details));
}

// ---------------------------------------------------------------- tests

test('existing projects are not shared by default and the project view keeps its shape', async context => {
    const f = await fixture(context);
    const manager = f.employee('shared_default_manager');
    const created = await project(manager, '默认不共享项目');
    assert.equal(created.shared, false);
    assert.equal(f.db.prepare('SELECT shared FROM projects WHERE id=?').get(created.id).shared, 0);
    const listed = (await manager.call('GET', '/api/projects')).body.projects.find(item => item.id === created.id);
    assert.equal(listed.shared, false);
    // Everything the frontend already relied on is still there.
    for (const key of ['id', 'name', 'description', 'instructions', 'archived', 'role', 'createdBy', 'memberCount', 'createdAt', 'updatedAt']) {
        assert.ok(key in listed, 'missing project field: ' + key);
    }
    assert.equal((await manager.call('GET', '/api/projects/shared')).body.projects.length, 0, 'nothing is grantable yet');
});

test('only a project administrator can publish a project, and shared never widens visibility', async context => {
    const f = await fixture(context);
    const manager = f.employee('shared_flag_manager');
    const member = f.employee('shared_flag_member');
    const outsider = f.employee('shared_flag_outsider');
    const created = await project(manager, '可共享项目');
    await addMember(manager, created.id, member);

    const shared = await share(manager, created.id, true);
    assert.equal(shared.shared, true);
    assert.equal(audits(f, 'project.share_update').length, 1);
    assert.equal(audits(f, 'project.share_update')[0].shared, true);

    // The member sees it in the shared list; the outsider does not, even though shared=1.
    const memberList = (await member.call('GET', '/api/projects/shared')).body.projects;
    assert.deepEqual(memberList.map(item => item.id), [created.id]);
    assert.equal(memberList[0].role, 'member');
    assert.equal(memberList[0].memberCount, 2);
    assert.equal(memberList[0].archived, false);
    assert.equal(typeof memberList[0].updatedAt, 'number');
    assert.deepEqual((await outsider.call('GET', '/api/projects/shared')).body.projects, []);
    assert.equal((await outsider.call('GET', '/api/projects')).body.projects.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE user_id=?').get(outsider.id).count, 0);

    // A plain member cannot flip the flag; the administrator can turn it back off.
    const denied = await member.call('PATCH', '/api/projects/' + created.id, { shared: false });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PROJECT_ADMIN_REQUIRED');
    assert.equal((await share(manager, created.id, false)).shared, false);
    assert.deepEqual((await member.call('GET', '/api/projects/shared')).body.projects, []);
    const invalid = await manager.call('PATCH', '/api/projects/' + created.id, { shared: 'yes' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_PROJECT_INPUT');
});

test('an archived project cannot change its shared flag until it is restored', async context => {
    const f = await fixture(context);
    const manager = f.employee('shared_archive_manager');
    const created = await project(manager, '归档项目');
    assert.equal((await manager.call('PATCH', '/api/projects/' + created.id, { archived: true })).status, 200);
    const denied = await manager.call('PATCH', '/api/projects/' + created.id, { shared: true });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'PROJECT_ARCHIVED');
    assert.equal((await manager.call('PATCH', '/api/projects/' + created.id, { archived: false })).status, 200);
    assert.equal((await manager.call('PATCH', '/api/projects/' + created.id, { shared: true })).status, 200);
});

test('creating an account can grant several shared projects at once', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_a', 'admin');
    const manager = f.employee('shared_grant_manager');
    const first = await project(manager, '共享项目一');
    const second = await project(manager, '共享项目二');
    await share(manager, first.id);
    await share(manager, second.id);

    const created = await root.call('POST', '/api/admin/users', { username: 'granted_account', displayName: '被授权账号',
        password: 'Password2026!', sharedProjectIds: [first.id, second.id] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const userId = created.body.user.id;
    assert.equal(created.body.user.memberships.length, 2);
    assert.deepEqual(created.body.user.memberships.map(item => item.role), ['member', 'member']);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE user_id=?').get(userId).count, 2);
    assert.equal(memberRow(f, first.id, userId).role, 'member');
});

test('re-submitting the same grants is idempotent and never duplicates membership rows', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_b', 'admin');
    const manager = f.employee('shared_idempotent_manager');
    const target = f.employee('shared_idempotent_target');
    const created = await project(manager, '幂等共享项目');
    await share(manager, created.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [created.id] });
        assert.equal(response.status, 200, 'attempt ' + attempt + ': ' + JSON.stringify(response.body));
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE user_id=? AND project_id=?')
        .get(target.id, created.id).count, 1);
    const events = audits(f, 'admin.shared_project_sync');
    assert.equal(events.length, 3);
    assert.equal(events[0].granted, 1, 'the first call creates the membership');
    assert.equal(events[1].granted, 0, 'later calls are no-ops');
    assert.equal(events[2].granted, 0);
    // Duplicate ids inside one request collapse instead of failing.
    const duplicated = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [created.id, created.id] });
    assert.equal(duplicated.status, 200);
});

test('a project administrator is never downgraded by a bulk grant or revoke', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_c', 'admin');
    const manager = f.employee('shared_admin_manager');
    const target = f.employee('shared_admin_target');
    const created = await project(manager, '管理员保留项目');
    await addMember(manager, created.id, target, 'admin');
    await share(manager, created.id);
    assert.equal(memberRow(f, created.id, target.id).role, 'admin');

    const granted = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [created.id] });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(memberRow(f, created.id, target.id).role, 'admin', 'granting must not rewrite an existing admin role');

    const revoked = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [] });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(memberRow(f, created.id, target.id).role, 'admin', 'revoking must not remove a project administrator');
    assert.equal(audits(f, 'admin.shared_project_sync').at(-1).revoked, 0);
});

test('unchecking a shared project removes membership and is audited', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_d', 'admin');
    const manager = f.employee('shared_revoke_manager');
    const target = f.employee('shared_revoke_target');
    const created = await project(manager, '撤销共享项目');
    await share(manager, created.id);
    await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [created.id] });
    assert.ok(memberRow(f, created.id, target.id));

    const revoked = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [] });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(memberRow(f, created.id, target.id), undefined);
    assert.equal(revoked.body.user.memberships.length, 0);
    const event = audits(f, 'admin.shared_project_sync').at(-1);
    assert.equal(event.revoked, 1);
    assert.equal(event.granted, 0);
    // The details never carry chat text; only counts and ids.
    assert.deepEqual(Object.keys(event).sort(), ['granted', 'projectIdCount', 'projectIds', 'revoked']);
});

test('granting a project that is not shared (or archived, or unknown) is refused', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_e', 'admin');
    const manager = f.employee('shared_refuse_manager');
    const target = f.employee('shared_refuse_target');
    const plain = await project(manager, '未共享项目');
    const archived = await project(manager, '已归档共享项目');
    await share(manager, archived.id);
    assert.equal((await manager.call('PATCH', '/api/projects/' + archived.id, { archived: true })).status, 200);

    for (const [ids, label] of [[[plain.id], 'not shared'], [[archived.id], 'archived'], [[randomUUID()], 'unknown'], [['a', plain.id], 'mixed']]) {
        const response = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: ids });
        assert.equal(response.status, 409, label + ' -> ' + JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'PROJECT_NOT_SHARED', label);
    }
    const created = await root.call('POST', '/api/admin/users', { username: 'refused_account', displayName: '被拒绝账号',
        password: 'Password2026!', sharedProjectIds: [plain.id] });
    assert.equal(created.status, 409);
    assert.equal(created.body.error.code, 'PROJECT_NOT_SHARED');
    assert.equal(f.db.prepare('SELECT id FROM users WHERE username=?').get('refused_account'), undefined, 'the account is not created');
});

test('the grant payload is validated: array of ids only, at most 50 entries, active accounts only', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_f', 'admin');
    const manager = f.employee('shared_validate_manager');
    const target = f.employee('shared_validate_target');
    const created = await project(manager, '校验共享项目');
    await share(manager, created.id);

    for (const [value, status, code] of [[['x'], 409, 'PROJECT_NOT_SHARED'], ['not-an-array', 400, 'INVALID_SHARED_PROJECTS'],
        [[1, 2], 400, 'INVALID_SHARED_PROJECTS'], [[null], 400, 'INVALID_SHARED_PROJECTS'], [[''], 400, 'INVALID_SHARED_PROJECTS']]) {
        const response = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: value });
        assert.equal(response.status, status, JSON.stringify(value) + ' -> ' + JSON.stringify(response.body));
        assert.equal(response.body.error.code, code, JSON.stringify(value));
    }
    const tooMany = Array.from({ length: 51 }, () => randomUUID());
    const limited = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: tooMany });
    assert.equal(limited.status, 409);
    assert.equal(limited.body.error.code, 'SHARED_PROJECT_LIMIT');

    // A disabled account cannot be granted new project access.
    assert.equal((await root.call('PATCH', '/api/admin/users/' + target.id, { active: false })).status, 200);
    const inactive = await root.call('PATCH', '/api/admin/users/' + target.id, { sharedProjectIds: [created.id] });
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.error.code, 'USER_INACTIVE');
});

test('revoking access takes effect immediately on every read path', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_g', 'admin');
    const manager = f.employee('shared_immediate_manager');
    const member = f.employee('shared_immediate_member');
    const created = await project(manager, '即时撤销项目');
    await addMember(manager, created.id, member);
    await share(manager, created.id);
    const conversation = await manager.call('POST', '/api/conversations', { projectId: created.id });
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    assert.equal((await member.call('GET', '/api/conversations?projectId=' + created.id)).status, 200);

    const revoked = await root.call('PATCH', '/api/admin/users/' + member.id, { sharedProjectIds: [] });
    assert.equal(revoked.status, 200);
    assert.deepEqual((await member.call('GET', '/api/projects/shared')).body.projects, []);
    assert.deepEqual((await member.call('GET', '/api/projects')).body.projects, []);
    assert.equal((await member.call('GET', '/api/conversations?projectId=' + created.id)).status, 403);
    assert.equal((await member.call('GET', '/api/projects/' + created.id + '/members')).status, 403);
    assert.equal((await member.call('POST', '/api/conversations', { projectId: created.id })).status, 403);
    assert.equal((await member.call('GET', '/api/projects/shared')).status, 200, 'the endpoint itself stays available');
});

test('revoking during a running answer stops it within a second and keeps the produced text', { timeout: 20000 }, async context => {
    const f = await fixture(context, { provider: {
        async *chat(messages, { signal }) {
            yield '第一段内容已经产出。';
            // Waits until the run is aborted instead of finishing on its own. The timer is
            // unref'd and cleared on abort so it can never keep the test process alive.
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 60000);
                timer.unref?.();
                signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
            });
            yield '第二段不应该出现。';
        },
    } });
    const root = f.employee('shared_root_h', 'admin');
    const manager = f.employee('shared_running_manager');
    const member = f.employee('shared_running_member');
    const created = await project(manager, '生成中撤销项目');
    await addMember(manager, created.id, member);
    await share(manager, created.id);
    const conversation = (await member.call('POST', '/api/conversations', { projectId: created.id })).body.conversation;
    const sent = await member.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: '帮我把门店这周的排班思路写出来。', requestId: randomUUID() });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const runId = sent.body.run.id;
    await eventually(async () => {
        const response = await member.call('GET', '/api/chat/runs/' + runId);
        return response.body.message.content.includes('第一段内容');
    }, 8000);

    const revokedAt = Date.now();
    assert.equal((await root.call('PATCH', '/api/admin/users/' + member.id, { sharedProjectIds: [] })).status, 200);
    // The project administrator can still read the member run; the revoked member cannot.
    const done = await eventually(async () => {
        const response = await manager.call('GET', '/api/chat/runs/' + runId);
        return response.body.run?.state === 'stopped' ? response.body : null;
    }, 2000);
    assert.equal((await member.call('GET', '/api/chat/runs/' + runId)).status, 403, 'the revoked member lost access');
    assert.ok(Date.now() - revokedAt <= 2000, 'the run must stop promptly after the revoke');
    assert.match(done.message.content, /第一段内容已经产出/, 'produced text is preserved');
    assert.doesNotMatch(done.message.content, /第二段/);
    assert.equal(done.run.errorCode, 'CHAT_ACCESS_REVOKED');
});

test('a disabled member cannot read the shared list and sees it again after being re-enabled', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_i', 'admin');
    const manager = f.employee('shared_disable_manager');
    const member = f.employee('shared_disable_member');
    const created = await project(manager, '停用可见性项目');
    await addMember(manager, created.id, member);
    await share(manager, created.id);
    assert.equal((await member.call('GET', '/api/projects/shared')).body.projects.length, 1);

    assert.equal((await root.call('PATCH', '/api/admin/users/' + member.id, { active: false })).status, 200);
    const disabled = await member.call('GET', '/api/projects/shared');
    assert.equal(disabled.status, 401, 'the session is invalidated immediately');

    assert.equal((await root.call('PATCH', '/api/admin/users/' + member.id, { active: true })).status, 200);
    relogin(f, member);
    const restored = await member.call('GET', '/api/projects/shared');
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.projects.map(item => item.id), [created.id]);
});

test('inside a shared project a member has full chat access but no project administration', async context => {
    const f = await fixture(context);
    const manager = f.employee('shared_readonly_manager');
    const member = f.employee('shared_readonly_member');
    const created = await project(manager, '只读共享项目');
    await manager.call('PATCH', '/api/projects/' + created.id, { instructions: '对外表达保持克制。' });
    await addMember(manager, created.id, member);
    await share(manager, created.id);

    // Readable...
    const members = await member.call('GET', '/api/projects/' + created.id + '/members');
    assert.equal(members.status, 200);
    assert.equal(members.body.members.length, 2);
    const conversation = await member.call('POST', '/api/conversations', { projectId: created.id });
    assert.equal(conversation.status, 201);
    // ...but never writable.
    for (const [method, route, body] of [['PATCH', '/api/projects/' + created.id, { name: '改名' }],
        ['PATCH', '/api/projects/' + created.id, { shared: false }],
        ['PUT', '/api/projects/' + created.id + '/members/' + member.id, { role: 'admin' }],
        ['DELETE', '/api/projects/' + created.id + '/members/' + member.id, {}]]) {
        const response = await member.call(method, route, body);
        assert.equal(response.status, 403, method + ' ' + route);
        assert.equal(response.body.error.code, 'PROJECT_ADMIN_REQUIRED');
    }
    // An archived shared project is read-only for chat as well.
    assert.equal((await manager.call('PATCH', '/api/projects/' + created.id, { archived: true })).status, 200);
    const listed = (await member.call('GET', '/api/projects/shared')).body.projects[0];
    assert.equal(listed.archived, true);
    const blocked = await member.call('POST', '/api/chat/runs', { conversationId: conversation.body.conversation.id,
        message: '还能发消息吗？', requestId: randomUUID() });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'PROJECT_ARCHIVED');
});

test('the audit trail records share changes and grants without any conversation content', async context => {
    const f = await fixture(context);
    const root = f.employee('shared_root_j', 'admin');
    const manager = f.employee('shared_audit_manager');
    const member = f.employee('shared_audit_member');
    const secret = '内部价格表：青禾精华 168 元。';
    const created = await project(manager, '审计共享项目');
    await manager.call('PATCH', '/api/projects/' + created.id, { instructions: secret });
    await share(manager, created.id);
    await root.call('PATCH', '/api/admin/users/' + member.id, { sharedProjectIds: [created.id] });
    const conversation = (await member.call('POST', '/api/conversations', { projectId: created.id })).body.conversation;
    await member.call('POST', '/api/chat/runs', { conversationId: conversation.id, message: secret, requestId: randomUUID() });
    await eventually(() => f.db.prepare("SELECT state FROM chat_runs WHERE conversation_id=?").get(conversation.id).state === 'completed', 8000);

    const shareEvents = audits(f, 'project.share_update');
    assert.equal(shareEvents.length, 1);
    assert.equal(shareEvents[0].shared, true);
    const grantEvents = audits(f, 'admin.shared_project_sync');
    assert.equal(grantEvents.length, 1);
    assert.equal(grantEvents[0].granted, 1);
    assert.equal(grantEvents[0].projectIdCount, 1);

    const dump = JSON.stringify(f.db.prepare('SELECT details FROM audit_records').all());
    assert.equal(dump.includes(secret), false, 'audit details never copy conversation or project text');
    assert.equal(dump.includes('168'), false);
});

// ---------------------------------------------------------------- frontend contract

test('the shared-project panel, sidebar entry, account form and settings rows are wired up', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const read = name => fs.readFileSync(path.join(root, name), 'utf8');

    // 1) Panel module: discovery list with role/archive badges and a click-through.
    const panelSource = read('src/shared-projects.js');
    const panel = await import('../src/shared-projects.js');
    assert.equal(typeof panel.openSharedProjectsPanel, 'function');
    assert.match(panelSource, /api\('\/api\/projects\/shared'\)/);
    assert.match(panelSource, /className: 'shared-project-row'/);
    assert.match(panelSource, /项目管理员/);
    assert.match(panelSource, /badge\('只读', 'warning'\)/);
    assert.match(panelSource, /view\.close\(\);\s*onSelect\?\.\(item\)/);
    assert.match(panelSource, /还没有共享项目/);
    assert.match(panelSource, /panel\('共享项目'/);

    // 2) Sidebar entry next to the other member entries, plus the current-project highlight.
    const app = read('src/app.js');
    assert.match(app, /import \{ openSharedProjectsPanel \} from '\.\/shared-projects\.js';/);
    assert.match(app, /button\('共享项目', \(\) => openSharedProjects\(\), \{ className: 'nav-item shared-projects-entry', glyph: 'folder' \}\)/);
    assert.match(app, /function openSharedProjects\(\) \{\s*openSharedProjectsPanel\(\{ currentProjectId: project\?\.id \|\| null, onSelect: value => \{/);
    assert.match(app, /querySelector\('\.shared-projects-entry'\)/);
    assert.match(app, /projects\.find\(item => item\.id === project\.id\)\?\.shared/);

    // 3) Control panel: grantable list, both forms submit sharedProjectIds, read-only health rows.
    const control = read('src/control-panel.js');
    assert.match(control, /projects\.filter\(item => item\.shared && !item\.archived\)/);
    assert.match(control, /className: 'checkbox-grid'/);
    assert.match(control, /撤销勾选会立即失去该项目访问权限/);
    assert.match(control, /sharedProjectIds: shared\.selected\(\)/, 'the create form submits grants');
    assert.match(control, /\.\.\.\(active\.checked \? \{ sharedProjectIds: shared\.selected\(\) \} : \{\}\)/, 'the edit form submits grants only for active accounts');
    assert.match(control, /\(account\.memberships \|\| \[\]\)\.map\(item => item\.projectId\)/, 'checked state comes from memberships');
    for (const field of ['data?.grounding?.mode', 'data?.search?.enabled', 'data?.chat?.breaker']) {
        assert.ok(control.includes(field), 'health row must read ' + field);
    }
    assert.match(control, /最近存储错误/);
    assert.match(control, /loadHealth\(\)/);

    // 4) A member sees no settings form, no member manager and no archive entry.
    const projects = read('src/projects.js');
    assert.match(projects, /const settings = canManage/);
    assert.match(projects, /if \(canManage\) loadMembers\(\)/);
    assert.match(projects, /项目设置、成员与归档由项目管理员管理/);
    assert.match(projects, /badge\('共享', 'shared-badge'\)/);

    // 5) Styles: every new class exists, colours come from variables, touch targets and
    //    reduced-motion rules are present.
    const css = read('src/studio.css');
    for (const selector of ['.shared-project-row', '.shared-project-identity', '.checkbox-grid', '.control-health', '.shared-badge']) {
        assert.ok(css.includes(selector), 'missing style: ' + selector);
    }
    assert.match(css, /\.shared-project-row \{ display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px/);
    assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.checkbox-grid \.check-field \{ min-height: 44px; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    const newStyles = css.slice(css.indexOf('.shared-project-list'));
    assert.doesNotMatch(newStyles.replace(/rgba\([^)]*\)/g, ''), /#[0-9a-fA-F]{3,8}\b/, 'no hard coded hex colours');
});
