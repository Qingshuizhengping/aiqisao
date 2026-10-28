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

function userView(row) {
    return { ...publicUser(row), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
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
    router.use((request, response, next) => {
        try { requireSystemAdmin(request.user); next(); } catch (error) { next(error); }
    });

    router.get('/users', (request, response, next) => {
        try {
            const { limit, offset } = pagination(request.query);
            const users = db.prepare('SELECT * FROM users ORDER BY created_at,id LIMIT ? OFFSET ?').all(limit, offset).map(userView);
            audit(db, request.user, 'admin.users_list', 'users', '*', { count: users.length, offset });
            response.json({ users });
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
        const currentActor = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(request.user.id);
        if (!currentActor) fail(403, 'SYSTEM_ADMIN_REQUIRED', '管理员权限已改变。');
        requireSystemAdmin(publicUser(currentActor));
        if (!db.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?').get(request.session.id, Date.now())) fail(401, 'AUTH_REQUIRED', '登录状态已改变，请重新登录。');
        const id = randomUUID();
        const time = Date.now();
        db.transaction(() => {
            if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'USERNAME_EXISTS', '账号已存在。');
            db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,must_change_password,created_at,updated_at)
                VALUES(?,?,?,?,?,1,?,?)`).run(id, username, name, passwordHash, role, time, time);
            audit(db, request.user, 'admin.user_create', 'user', id, { systemRole: role });
        })();
        response.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
    }));

    router.patch('/users/:id', (request, response, next) => {
        try {
            const input = objectInput(request.body, ['displayName', 'active', 'systemRole']);
            if (!Object.keys(input).length) fail(400, 'INVALID_ADMIN_INPUT', '请提供要修改的设置。');
            const row = db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
            if (!row) fail(404, 'USER_NOT_FOUND', '成员不存在。');
            const name = input.displayName === undefined ? row.display_name : displayName(input.displayName);
            if (input.active !== undefined && typeof input.active !== 'boolean') fail(400, 'INVALID_ADMIN_INPUT', '账号状态无效。');
            const active = input.active === undefined ? row.active : Number(input.active);
            const role = input.systemRole === undefined ? row.system_role : input.systemRole;
            if (!['admin', 'member'].includes(role)) fail(400, 'INVALID_SYSTEM_ROLE', '系统角色无效。');
            if (row.id === request.user.id && (!active || role !== 'admin')) fail(409, 'SELF_ADMIN_PROTECTED', '不能停用或撤销自己的管理员权限。');
            db.transaction(() => {
                if (row.active && row.system_role === 'admin' && (!active || role !== 'admin')) {
                    if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE active=1 AND system_role='admin'").get().count <= 1) fail(409, 'LAST_SYSTEM_ADMIN', '至少需要保留一位有效的系统管理员。');
                }
                if (row.active && !active) {
                    const soleProjects = db.prepare(`SELECT membership.project_id FROM project_members membership JOIN projects project ON project.id=membership.project_id
                        WHERE membership.user_id=? AND membership.role='admin' AND project.archived=0
                        AND NOT EXISTS(SELECT 1 FROM project_members other JOIN users employee ON employee.id=other.user_id
                            WHERE other.project_id=membership.project_id AND other.role='admin' AND other.user_id<>membership.user_id AND employee.active=1)`).all(row.id);
                    if (soleProjects.length) fail(409, 'LAST_PROJECT_ADMIN', '该成员仍是项目的唯一管理员，请先完成项目交接。');
                }
                db.prepare('UPDATE users SET display_name=?,active=?,system_role=?,updated_at=? WHERE id=?').run(name, active, role, Date.now(), row.id);
                if (!active || role !== row.system_role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
                audit(db, request.user, 'admin.user_update', 'user', row.id, { active: Boolean(active), systemRole: role });
            })();
            response.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id)) });
        } catch (error) { next(error); }
    });

    router.post('/users/:id/reset-password', asyncRoute(async (request, response) => {
        const input = objectInput(request.body, ['password']);
        validatePassword(input.password);
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(request.params.id);
        if (!row) fail(404, 'USER_NOT_FOUND', '成员不存在。');
        if (row.id === request.user.id) fail(409, 'USE_PASSWORD_SETTINGS', '请在账号设置中修改自己的密码。');
        const passwordHash = await hashPassword(input.password);
        const actor = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(request.user.id);
        if (!actor) fail(403, 'SYSTEM_ADMIN_REQUIRED', '管理员权限已改变。');
        requireSystemAdmin(publicUser(actor));
        if (!db.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?').get(request.session.id, Date.now())) fail(401, 'AUTH_REQUIRED', '登录状态已改变，请重新登录。');
        db.transaction(() => {
            db.prepare('UPDATE users SET password_hash=?,must_change_password=1,updated_at=? WHERE id=?').run(passwordHash, Date.now(), row.id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
            audit(db, request.user, 'admin.password_reset', 'user', row.id);
        })();
        response.json({ ok: true });
    }));

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
