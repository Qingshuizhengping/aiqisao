import express from 'express';
import { randomUUID } from 'node:crypto';
import { audit, publicUser, requireSystemAdmin } from './access.js';
import { asyncRoute, fail } from './errors.js';
import { hashPassword, validatePassword, validateUsername } from './auth.js';

function objectInput(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_ADMIN_INPUT', '管理参数无效。');
    return value;
}

function displayName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /\u0000/.test(value)) fail(400, 'INVALID_DISPLAY_NAME', '姓名需要 1–80 个字符。');
    return value.trim();
}

function userView(row, db) {
    const memberships = db.prepare(`SELECT membership.project_id AS projectId,project.name AS projectName,membership.role,project.archived
        FROM project_members membership JOIN projects project ON project.id=membership.project_id
        WHERE membership.user_id=? ORDER BY project.archived,project.name,project.id`).all(row.id)
        .map(item => ({ ...item, archived: Boolean(item.archived) }));
    return { ...publicUser(row, db), active: Boolean(row.active), deletedAt: row.deleted_at ?? null,
        projectCount: memberships.length, projectAdminCount: memberships.filter(item => item.role === 'admin').length,
        memberships, createdAt: row.created_at, updatedAt: row.updated_at };
}

function projectView(row, db) {
    const counts = db.prepare(`SELECT COUNT(*) AS memberCount,COALESCE(SUM(membership.role='admin'),0) AS adminCount
        FROM project_members membership JOIN users employee ON employee.id=membership.user_id
        WHERE membership.project_id=? AND employee.active=1 AND employee.deleted_at IS NULL`).get(row.id);
    return { id: row.id, name: row.name, archived: Boolean(row.archived), ...counts,
        createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

function pagination(query) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) fail(400, 'INVALID_PAGINATION', '分页参数无效。');
    return { limit, offset };
}

function filters(query) {
    const result = {};
    for (const name of ['userId', 'projectId', 'q']) {
        if (query[name] !== undefined && (typeof query[name] !== 'string' || query[name].length > 200)) fail(400, 'INVALID_AUDIT_FILTER', '查询条件无效。');
        result[name] = query[name] || '';
    }
    for (const name of ['from', 'to']) {
        if (query[name] === undefined || query[name] === '') { result[name] = null; continue; }
        if (typeof query[name] !== 'string' || query[name].length > 40) fail(400, 'INVALID_AUDIT_FILTER', '时间范围无效。');
        const value = /^\d+$/.test(query[name]) ? Number(query[name]) : Date.parse(query[name]);
        if (!Number.isSafeInteger(value) || value < 0) fail(400, 'INVALID_AUDIT_FILTER', '时间范围无效。');
        result[name] = value;
    }
    if (result.from !== null && result.to !== null && result.from > result.to) fail(400, 'INVALID_AUDIT_FILTER', '开始时间不能晚于结束时间。');
    return result;
}

function like(value) {
    return '%' + value.replace(/[\\%_]/g, character => '\\' + character) + '%';
}

function safeMetadata(value) {
    try { return JSON.parse(value); } catch { return {}; }
}

export function createAdminRouter({ db }) {
    const router = express.Router();

    function currentAdmin(request) {
        const row = db.prepare('SELECT * FROM users WHERE id=? AND active=1 AND deleted_at IS NULL').get(request.user?.id);
        if (!row) fail(403, 'SYSTEM_ADMIN_REQUIRED', '管理员权限已改变。');
        const user = publicUser(row, db);
        requireSystemAdmin(user);
        if (!request.session?.id || !db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>?')
            .get(request.session.id, user.id, Date.now())) fail(401, 'AUTH_REQUIRED', '登录状态已改变，请重新登录。');
        request.user = user;
        return user;
    }

    function targetUser(id, allowDeleted = false) {
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        if (!row) fail(404, 'USER_NOT_FOUND', '成员不存在。');
        if (!allowDeleted && row.deleted_at !== null) fail(409, 'USER_DELETED', '该账号已删除，请先恢复账号。');
        return row;
    }

    function protectAccount(row, nextActive, nextRole) {
        if (row.active && row.system_role === 'admin' && (!nextActive || nextRole !== 'admin')) {
            if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE active=1 AND deleted_at IS NULL AND system_role='admin'").get().count <= 1) {
                fail(409, 'LAST_SYSTEM_ADMIN', '至少需要保留一位有效的系统管理员。');
            }
        }
        if (row.active && !nextActive) {
            const soleProject = db.prepare(`SELECT membership.project_id FROM project_members membership JOIN projects project ON project.id=membership.project_id
                WHERE membership.user_id=? AND membership.role='admin' AND project.archived=0
                AND NOT EXISTS(SELECT 1 FROM project_members other JOIN users employee ON employee.id=other.user_id
                    WHERE other.project_id=membership.project_id AND other.role='admin' AND other.user_id<>membership.user_id
                    AND employee.active=1 AND employee.deleted_at IS NULL) LIMIT 1`).get(row.id);
            if (soleProject) fail(409, 'LAST_PROJECT_ADMIN', '该成员仍是项目的唯一管理员，请先完成项目交接。');
        }
    }

    function editableProject(id) {
        const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!row) fail(404, 'PROJECT_NOT_FOUND', '项目不存在。');
        if (row.archived) fail(409, 'PROJECT_ARCHIVED', '项目已归档，当前为只读。');
        return row;
    }

    function protectProjectAdmin(projectId, user, nextRole) {
        const membership = db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, user.id);
        if (!user.active || membership?.role !== 'admin' || nextRole === 'admin') return;
        const count = db.prepare(`SELECT COUNT(*) AS count FROM project_members membership JOIN users employee ON employee.id=membership.user_id
            WHERE membership.project_id=? AND membership.role='admin' AND employee.active=1 AND employee.deleted_at IS NULL`).get(projectId).count;
        if (count <= 1) fail(409, 'LAST_PROJECT_ADMIN', '请先指定另一位有效的项目管理员。');
    }

    function filteredUsers(query) {
        const { limit, offset } = pagination(query);
        for (const field of ['q', 'status', 'systemRole']) {
            if (query[field] !== undefined && (typeof query[field] !== 'string' || query[field].length > 200)) fail(400, 'INVALID_USER_FILTER', '账号筛选条件无效。');
        }
        const status = query.status || 'current';
        const role = query.systemRole || '';
        if (!['current', 'active', 'disabled', 'deleted', 'all'].includes(status) || !['', 'admin', 'member'].includes(role)) {
            fail(400, 'INVALID_USER_FILTER', '账号筛选条件无效。');
        }
        const clauses = [], values = [];
        if (status === 'deleted') clauses.push('deleted_at IS NOT NULL');
        else if (status !== 'all') {
            clauses.push('deleted_at IS NULL');
            if (status === 'active') clauses.push('active=1');
            if (status === 'disabled') clauses.push('active=0');
        }
        if (role) { clauses.push('system_role=?'); values.push(role); }
        if (query.q) { clauses.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')"); values.push(like(query.q), like(query.q)); }
        const rows = db.prepare(`SELECT * FROM users ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY deleted_at IS NOT NULL,active DESC,created_at,id LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
        return { users: rows.slice(0, limit).map(row => userView(row, db)), hasMore: rows.length > limit, limit, offset };
    }

    router.use((request, response, next) => {
        try { currentAdmin(request); next(); } catch (error) { next(error); }
    });

    router.get('/control-panel', (request, response, next) => {
        try {
            const selected = filteredUsers({ limit: 100, ...request.query });
            const summary = db.prepare(`SELECT COUNT(*) AS totalUsers,
                COALESCE(SUM(active=1 AND deleted_at IS NULL),0) AS activeUsers,
                COALESCE(SUM(active=0 AND deleted_at IS NULL),0) AS disabledUsers,
                COALESCE(SUM(deleted_at IS NOT NULL),0) AS deletedUsers,
                COALESCE(SUM(active=1 AND deleted_at IS NULL AND system_role='admin'),0) AS systemAdmins FROM users`).get();
            const projectSummary = db.prepare(`SELECT COUNT(*) AS totalProjects,COALESCE(SUM(archived=0),0) AS activeProjects,
                COALESCE(SUM(archived=1),0) AS archivedProjects FROM projects`).get();
            const projects = db.prepare('SELECT * FROM projects ORDER BY archived,updated_at DESC,id').all().map(row => projectView(row, db));
            audit(db, request.user, 'admin.control_panel', 'users', '*', { count: selected.users.length, offset: selected.offset });
            response.json({ summary: { ...summary, ...projectSummary }, ...selected, projects });
        } catch (error) { next(error); }
    });

    router.get('/users', (request, response, next) => {
        try {
            const selected = filteredUsers({ status: 'all', ...request.query });
            audit(db, request.user, 'admin.users_list', 'users', '*', { count: selected.users.length, offset: selected.offset });
            response.json(selected);
        } catch (error) { next(error); }
    });

    router.post('/users', asyncRoute(async (request, response) => {
        const input = objectInput(request.body, ['username', 'displayName', 'password', 'systemRole']);
        const username = validateUsername(input.username);
        const name = displayName(input.displayName);
        const role = input.systemRole ?? 'member';
        if (!['admin', 'member'].includes(role)) fail(400, 'INVALID_SYSTEM_ROLE', '系统角色无效。');
        if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'USERNAME_EXISTS', '账号已存在。');
        const passwordHash = await hashPassword(input.password);
        currentAdmin(request);
        const id = randomUUID();
        const time = Date.now();
        db.transaction(() => {
            if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'USERNAME_EXISTS', '账号已存在。');
            db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,must_change_password,created_at,updated_at)
                VALUES(?,?,?,?,?,1,?,?)`).run(id, username, name, passwordHash, role, time, time);
            audit(db, request.user, 'admin.user_create', 'user', id, { systemRole: role });
        })();
        response.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(id), db) });
    }));

    router.patch('/users/:id', (request, response, next) => {
        try {
            const input = objectInput(request.body, ['displayName', 'active', 'systemRole']);
            if (!Object.keys(input).length) fail(400, 'INVALID_ADMIN_INPUT', '请提供要修改的设置。');
            const row = targetUser(request.params.id);
            const name = input.displayName === undefined ? row.display_name : displayName(input.displayName);
            if (input.active !== undefined && typeof input.active !== 'boolean') fail(400, 'INVALID_ADMIN_INPUT', '账号状态无效。');
            const active = input.active === undefined ? row.active : Number(input.active);
            const role = input.systemRole === undefined ? row.system_role : input.systemRole;
            if (!['admin', 'member'].includes(role)) fail(400, 'INVALID_SYSTEM_ROLE', '系统角色无效。');
            if (row.id === request.user.id && (!active || role !== 'admin')) fail(409, 'SELF_ADMIN_PROTECTED', '不能停用或撤销自己的管理员权限。');
            db.transaction(() => {
                currentAdmin(request);
                protectAccount(row, active, role);
                db.prepare('UPDATE users SET display_name=?,active=?,system_role=?,updated_at=? WHERE id=?').run(name, active, role, Date.now(), row.id);
                if (!active || role !== row.system_role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
                audit(db, request.user, 'admin.user_update', 'user', row.id, { active: Boolean(active), systemRole: role });
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db) });
        } catch (error) { next(error); }
    });

    router.post('/users/:id/reset-password', asyncRoute(async (request, response) => {
        const input = objectInput(request.body, ['password']);
        validatePassword(input.password);
        const row = targetUser(request.params.id);
        if (row.id === request.user.id) fail(409, 'USE_PASSWORD_SETTINGS', '请在账号设置中修改自己的密码。');
        const passwordHash = await hashPassword(input.password);
        currentAdmin(request);
        db.transaction(() => {
            targetUser(row.id);
            db.prepare('UPDATE users SET password_hash=?,must_change_password=1,updated_at=? WHERE id=?').run(passwordHash, Date.now(), row.id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
            audit(db, request.user, 'admin.password_reset', 'user', row.id);
        })();
        response.json({ ok: true });
    }));

    router.delete('/users/:id', (request, response, next) => {
        try {
            const row = targetUser(request.params.id);
            if (row.id === request.user.id) fail(409, 'SELF_ADMIN_PROTECTED', '不能删除自己的管理员账号。');
            db.transaction(() => {
                currentAdmin(request);
                protectAccount(row, 0, row.system_role);
                const now = Date.now();
                db.prepare('UPDATE users SET active=0,deleted_at=?,updated_at=? WHERE id=?').run(now, now, row.id);
                db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
                audit(db, request.user, 'admin.user_delete', 'user', row.id, { retainedHistory: true });
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db) });
        } catch (error) { next(error); }
    });

    router.post('/users/:id/restore', (request, response, next) => {
        try {
            objectInput(request.body || {}, []);
            const row = targetUser(request.params.id, true);
            if (row.deleted_at === null) fail(409, 'USER_NOT_DELETED', '该账号未删除，无需恢复。');
            db.transaction(() => {
                currentAdmin(request);
                db.prepare('UPDATE users SET active=0,deleted_at=NULL,updated_at=? WHERE id=?').run(Date.now(), row.id);
                db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
                audit(db, request.user, 'admin.user_restore', 'user', row.id, { active: false });
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db) });
        } catch (error) { next(error); }
    });

    function userProjects(user) {
        return db.prepare(`SELECT project.*,membership.role FROM projects project LEFT JOIN project_members membership
            ON membership.project_id=project.id AND membership.user_id=? ORDER BY project.archived,project.name,project.id`).all(user.id)
            .map(row => ({ ...projectView(row, db), role: row.role || null,
                canAssign: Boolean(!row.archived && !user.deleted_at && user.active),
                canRevoke: Boolean(!row.archived && !user.deleted_at && row.role) }));
    }

    router.get('/users/:id/projects', (request, response, next) => {
        try {
            const row = targetUser(request.params.id, true);
            const projects = userProjects(row);
            audit(db, request.user, 'admin.user_projects_list', 'user', row.id, { count: projects.length });
            response.json({ user: userView(row, db), projects });
        } catch (error) { next(error); }
    });

    router.put('/users/:id/projects/:projectId', (request, response, next) => {
        try {
            const input = objectInput(request.body, ['role']);
            if (!['member', 'admin'].includes(input.role)) fail(400, 'INVALID_PROJECT_ROLE', '项目角色无效。');
            const row = targetUser(request.params.id);
            if (!row.active) fail(409, 'USER_INACTIVE', '请先启用账号，再分配项目权限。');
            editableProject(request.params.projectId);
            db.transaction(() => {
                currentAdmin(request);
                protectProjectAdmin(request.params.projectId, row, input.role);
                const now = Date.now();
                db.prepare(`INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)
                    ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role`).run(request.params.projectId, row.id, input.role, now);
                db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, request.params.projectId);
                audit(db, request.user, 'admin.project_member_set', 'project', request.params.projectId, { userId: row.id, role: input.role });
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db), projects: userProjects(row) });
        } catch (error) { next(error); }
    });

    router.delete('/users/:id/projects/:projectId', (request, response, next) => {
        try {
            const row = targetUser(request.params.id);
            editableProject(request.params.projectId);
            db.transaction(() => {
                currentAdmin(request);
                protectProjectAdmin(request.params.projectId, row, null);
                const changed = db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(request.params.projectId, row.id);
                if (changed.changes) {
                    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(Date.now(), request.params.projectId);
                    audit(db, request.user, 'admin.project_member_remove', 'project', request.params.projectId, { userId: row.id });
                }
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db), projects: userProjects(row) });
        } catch (error) { next(error); }
    });

    router.get('/audit/conversations', (request, response, next) => {
        try {
            const filter = filters(request.query);
            const { limit, offset } = pagination(request.query);
            const clauses = [];
            const values = [];
            if (filter.userId) { clauses.push('conversation.user_id=?'); values.push(filter.userId); }
            if (filter.projectId) { clauses.push('conversation.project_id=?'); values.push(filter.projectId); }
            if (filter.from !== null) { clauses.push('conversation.updated_at>=?'); values.push(filter.from); }
            if (filter.to !== null) { clauses.push('conversation.updated_at<=?'); values.push(filter.to); }
            if (filter.q) {
                clauses.push(`(conversation.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages message WHERE message.conversation_id=conversation.id AND message.content LIKE ? ESCAPE '\\'))`);
                values.push(like(filter.q), like(filter.q));
            }
            const rows = db.prepare(`SELECT conversation.*,employee.username,employee.display_name,project.name AS project_name
                FROM conversations conversation JOIN users employee ON employee.id=conversation.user_id
                LEFT JOIN projects project ON project.id=conversation.project_id ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
                ORDER BY conversation.updated_at DESC,conversation.id LIMIT ? OFFSET ?`).all(...values, limit, offset);
            audit(db, request.user, 'audit.conversations_list', 'conversations', '*', { count: rows.length, offset, filterUserId: filter.userId, filterProjectId: filter.projectId, hasSearch: Boolean(filter.q) });
            response.json({ conversations: rows.map(row => ({ id: row.id, userId: row.user_id, ownerName: row.display_name,
                ownerUsername: row.username, projectId: row.project_id, projectName: row.project_name, title: row.title,
                createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
                memoryEnabled: Boolean(row.memory_enabled), readOnly: true })) });
        } catch (error) { next(error); }
    });

    router.get('/audit/conversations/:id', (request, response, next) => {
        try {
            const row = db.prepare(`SELECT conversation.*,employee.display_name,project.name AS project_name FROM conversations conversation
                JOIN users employee ON employee.id=conversation.user_id LEFT JOIN projects project ON project.id=conversation.project_id
                WHERE conversation.id=?`).get(request.params.id);
            if (!row) fail(404, 'CONVERSATION_NOT_FOUND', '对话不存在。');
            const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id').all(row.id);
            audit(db, request.user, 'audit.conversation_read', 'conversation', row.id, { ownerId: row.user_id, projectId: row.project_id, count: messages.length });
            response.json({ conversation: { id: row.id, userId: row.user_id, ownerName: row.display_name, projectId: row.project_id,
                projectName: row.project_name, title: row.title, memoryEnabled: Boolean(row.memory_enabled), readOnly: true,
                createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }, messages: messages.map(message => ({ id: message.id,
                conversationId: message.conversation_id, role: message.role, content: message.content, status: message.status,
                metadata: safeMetadata(message.metadata), createdAt: message.created_at, updatedAt: message.updated_at })) });
        } catch (error) { next(error); }
    });

    router.get('/audit/memories', (request, response, next) => {
        try {
            const filter = filters(request.query);
            const { limit, offset } = pagination(request.query);
            if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get()) return response.json({ memories: [] });
            const clauses = ["memory.status<>'deleted'", 'memory.deleted_at IS NULL'];
            const values = [];
            if (filter.userId) { clauses.push('memory.user_id=?'); values.push(filter.userId); }
            if (filter.projectId) { clauses.push('memory.project_id=?'); values.push(filter.projectId); }
            if (filter.from !== null) { clauses.push('memory.updated_at>=?'); values.push(filter.from); }
            if (filter.to !== null) { clauses.push('memory.updated_at<=?'); values.push(filter.to); }
            if (filter.q) { clauses.push("memory.content LIKE ? ESCAPE '\\'"); values.push(like(filter.q)); }
            const rows = db.prepare(`SELECT memory.*,employee.display_name,project.name AS project_name FROM memories memory
                LEFT JOIN users employee ON employee.id=memory.user_id LEFT JOIN projects project ON project.id=memory.project_id
                WHERE ${clauses.join(' AND ')} ORDER BY memory.updated_at DESC,memory.id LIMIT ? OFFSET ?`).all(...values, limit, offset);
            audit(db, request.user, 'audit.memories_list', 'memories', '*', { count: rows.length, offset, filterUserId: filter.userId, filterProjectId: filter.projectId, hasSearch: Boolean(filter.q) });
            response.json({ memories: rows.map(row => ({ id: row.id, scope: row.scope, userId: row.user_id, ownerName: row.display_name,
                projectId: row.project_id, projectName: row.project_name, content: row.content, status: row.status,
                sourceConversationId: row.source_conversation_id, sourceMessageId: row.source_message_id,
                createdAt: row.created_at, updatedAt: row.updated_at, canEdit: false, canReview: false, readOnly: true })) });
        } catch (error) { next(error); }
    });

    router.get('/audit/events', (request, response, next) => {
        try {
            const { limit, offset } = pagination(request.query);
            if (request.query.actorId !== undefined && (typeof request.query.actorId !== 'string' || request.query.actorId.length > 200)) fail(400, 'INVALID_AUDIT_FILTER', '操作者筛选无效。');
            const actor = request.query.actorId || '';
            const filter = filters(request.query);
            const clauses = [];
            const values = [];
            if (actor) { clauses.push('event.actor_id=?'); values.push(actor); }
            if (filter.from !== null) { clauses.push('event.created_at>=?'); values.push(filter.from); }
            if (filter.to !== null) { clauses.push('event.created_at<=?'); values.push(filter.to); }
            const rows = db.prepare(`SELECT event.*,employee.display_name FROM audit_records event LEFT JOIN users employee ON employee.id=event.actor_id
                ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY event.created_at DESC,event.id LIMIT ? OFFSET ?`).all(...values, limit, offset);
            audit(db, request.user, 'audit.events_list', 'audit_records', '*', { count: rows.length, offset, filterActorId: actor });
            response.json({ events: rows.map(row => ({ id: row.id, actorId: row.actor_id, actorName: row.display_name,
                action: row.action, targetType: row.target_type, targetId: row.target_id, details: safeMetadata(row.details), createdAt: row.created_at })) });
        } catch (error) { next(error); }
    });

    return router;
}
