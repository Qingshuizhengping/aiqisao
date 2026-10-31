import express from 'express';
import { randomUUID } from 'node:crypto';
import { audit, assertProjectAdminRemovable, projectRole, requireProjectAdmin, requireProjectContext, requireProjectMember } from './access.js';
import { fail } from './errors.js';

function objectInput(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_PROJECT_INPUT', '项目参数无效。');
    return value;
}

function text(value, maximum, required = false) {
    if (typeof value !== 'string' || value.trim().length > maximum || required && !value.trim() || /\u0000/.test(value)) fail(400, 'INVALID_PROJECT_INPUT', '项目文字内容无效或超过长度限制。');
    return value.trim();
}

function projectView(db, user, row) {
    return { id: row.id, name: row.name, description: row.description, instructions: row.instructions,
        archived: Boolean(row.archived), shared: Boolean(row.shared),
        role: projectRole(db, user, row.id), createdBy: row.created_by,
        memberCount: db.prepare(`SELECT COUNT(*) AS count FROM project_members membership JOIN users employee ON employee.id=membership.user_id
            WHERE membership.project_id=? AND employee.active=1`).get(row.id).count,
        createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createProjectsRouter({ db }) {
    const router = express.Router();

    function editableProject(user, id) {
        requireProjectAdmin(db, user, id);
        return requireProjectContext(db, user, id, { write: true }).project;
    }

    router.get('/', (request, response, next) => {
        try {
            const rows = db.prepare(`SELECT project.* FROM projects project JOIN project_members membership ON membership.project_id=project.id
                WHERE membership.user_id=? ORDER BY project.archived,project.updated_at DESC,project.id`).all(request.user.id);
            response.json({ projects: rows.map(row => projectView(db, request.user, row)) });
        } catch (error) { next(error); }
    });

    // R4-03: the projects this member joined *and* that are marked as shared. Registered
    // before any `/:id` route so a future `GET /:id` can never shadow it. Visibility still
    // comes from `project_members` alone: a shared project the member is not in is invisible.
    router.get('/shared', (request, response, next) => {
        try {
            const rows = db.prepare(`SELECT project.* FROM projects project
                JOIN project_members membership ON membership.project_id=project.id
                JOIN users employee ON employee.id=membership.user_id
                WHERE membership.user_id=? AND project.shared=1 AND employee.active=1 AND employee.deleted_at IS NULL
                ORDER BY project.archived,project.updated_at DESC,project.id`).all(request.user.id);
            response.json({ projects: rows.map(row => ({ id: row.id, name: row.name, role: projectRole(db, request.user, row.id),
                memberCount: db.prepare(`SELECT COUNT(*) AS count FROM project_members membership JOIN users employee ON employee.id=membership.user_id
                    WHERE membership.project_id=? AND employee.active=1 AND employee.deleted_at IS NULL`).get(row.id).count,
                archived: Boolean(row.archived), updatedAt: row.updated_at })) });
        } catch (error) { next(error); }
    });

    router.post('/', (request, response, next) => {
        try {
            const input = objectInput(request.body, ['name', 'description', 'instructions']);
            const name = text(input.name, 80, true);
            const description = text(input.description ?? '', 6000);
            const instructions = text(input.instructions ?? '', 12000);
            if (db.prepare('SELECT COUNT(*) AS count FROM projects WHERE created_by=? AND archived=0').get(request.user.id).count >= 100) fail(429, 'PROJECT_LIMIT', '项目数量过多，请先归档不再使用的项目。');
            const id = randomUUID();
            const time = Date.now();
            db.transaction(() => {
                db.prepare('INSERT INTO projects(id,name,description,instructions,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
                    .run(id, name, description, instructions, request.user.id, time, time);
                db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)').run(id, request.user.id, 'admin', time);
                audit(db, request.user, 'project.create', 'project', id);
            })();
            response.status(201).json({ project: projectView(db, request.user, db.prepare('SELECT * FROM projects WHERE id=?').get(id)) });
        } catch (error) { next(error); }
    });

    router.patch('/:id', (request, response, next) => {
        try {
            requireProjectAdmin(db, request.user, request.params.id);
            const { project: row } = requireProjectContext(db, request.user, request.params.id);
            const input = objectInput(request.body, ['name', 'description', 'instructions', 'archived', 'shared']);
            if (!Object.keys(input).length) fail(400, 'INVALID_PROJECT_INPUT', '请提供要修改的内容。');
            if (input.archived !== undefined && typeof input.archived !== 'boolean') fail(400, 'INVALID_PROJECT_INPUT', '归档设置无效。');
            // Only a project administrator may publish a project for cross-account grants, and
            // an archived project has to be restored first (same rule as every other edit).
            if (input.shared !== undefined && typeof input.shared !== 'boolean') fail(400, 'INVALID_PROJECT_INPUT', '共享设置无效。');
            if (row.archived && (input.archived !== false || Object.keys(input).some(key => key !== 'archived'))) fail(409, 'PROJECT_ARCHIVED', '请先恢复项目，再修改内容。');
            const name = input.name === undefined ? row.name : text(input.name, 80, true);
            const description = input.description === undefined ? row.description : text(input.description, 6000);
            const instructions = input.instructions === undefined ? row.instructions : text(input.instructions, 12000);
            const archived = input.archived === undefined ? row.archived : Number(input.archived);
            const shared = input.shared === undefined ? Number(row.shared || 0) : Number(input.shared);
            db.transaction(() => {
                db.prepare('UPDATE projects SET name=?,description=?,instructions=?,archived=?,shared=?,updated_at=? WHERE id=?')
                    .run(name, description, instructions, archived, shared, Date.now(), row.id);
                audit(db, request.user, 'project.update', 'project', row.id, { fields: Object.keys(input).join(','), archived: Boolean(archived) });
                if (input.shared !== undefined) audit(db, request.user, 'project.share_update', 'project', row.id, { shared: Boolean(shared) });
            })();
            response.json({ project: projectView(db, request.user, db.prepare('SELECT * FROM projects WHERE id=?').get(row.id)) });
        } catch (error) { next(error); }
    });

    router.get('/:id/members', (request, response, next) => {
        try {
            requireProjectMember(db, request.user, request.params.id);
            const rows = db.prepare(`SELECT employee.id,employee.username,employee.display_name,employee.active,membership.role,membership.created_at
                FROM project_members membership JOIN users employee ON employee.id=membership.user_id
                WHERE membership.project_id=? ORDER BY membership.role,employee.display_name`).all(request.params.id);
            response.json({ members: rows.map(row => ({ id: row.id, userId: row.id, username: row.username,
                displayName: row.display_name, active: Boolean(row.active), role: row.role, createdAt: row.created_at })) });
        } catch (error) { next(error); }
    });

    router.put('/:id/members/:userId', (request, response, next) => {
        try {
            editableProject(request.user, request.params.id);
            const input = objectInput(request.body, ['role']);
            if (!['admin', 'member'].includes(input.role)) fail(400, 'INVALID_PROJECT_ROLE', '项目角色无效。');
            if (!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(request.params.userId)) fail(404, 'USER_NOT_FOUND', '该成员不存在或已停用。');
            db.transaction(() => {
                assertProjectAdminRemovable(db, request.params.id, request.params.userId, input.role);
                db.prepare(`INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)
                    ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role`)
                    .run(request.params.id, request.params.userId, input.role, Date.now());
                db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(Date.now(), request.params.id);
                audit(db, request.user, 'project.member_update', 'project', request.params.id, { userId: request.params.userId, role: input.role });
            })();
            response.json({ ok: true });
        } catch (error) { next(error); }
    });

    router.delete('/:id/members/:userId', (request, response, next) => {
        try {
            editableProject(request.user, request.params.id);
            db.transaction(() => {
                assertProjectAdminRemovable(db, request.params.id, request.params.userId, null);
                db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(request.params.id, request.params.userId);
                db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(Date.now(), request.params.id);
                audit(db, request.user, 'project.member_remove', 'project', request.params.id, { userId: request.params.userId });
            })();
            response.json({ ok: true });
        } catch (error) { next(error); }
    });

    return router;
}
