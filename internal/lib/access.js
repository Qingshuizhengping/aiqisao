import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

export function publicUser(row, db) {
    return { id: row.id, username: row.username, displayName: row.display_name,
        systemRole: row.system_role, autoMemoryEnabled: Boolean(row.auto_memory_enabled),
        mustChangePassword: Boolean(row.must_change_password), mfaEnabled: false, mfaRequired: false };
}

export function requireReadyEmployee(db, user) {
    const row = user?.id && db.prepare('SELECT * FROM users WHERE id=? AND active=1 AND deleted_at IS NULL').get(user.id);
    if (!row) fail(401, 'AUTH_REQUIRED', '请重新登录。');
    const actor = publicUser(row, db);
    if (actor.mustChangePassword) fail(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
    return { row, user: actor };
}

export function projectRole(db, user, projectId) {
    if (!user?.id || !projectId) return null;
    const membership = db.prepare(`SELECT membership.role FROM project_members membership
        JOIN users employee ON employee.id=membership.user_id
        JOIN projects project ON project.id=membership.project_id
        WHERE membership.project_id=? AND membership.user_id=? AND employee.active=1 AND employee.deleted_at IS NULL`).get(projectId, user.id);
    return membership?.role || null;
}

export function requireProjectMember(db, user, projectId) {
    const role = projectRole(db, user, projectId);
    if (!role) fail(403, 'PROJECT_ACCESS_DENIED', '你没有这个项目的访问权限。');
    return role;
}

export function requireProjectContext(db, user, projectId, { write = false, archivedMessage = '项目已归档，当前为只读。' } = {}) {
    const role = requireProjectMember(db, user, projectId);
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!project) fail(404, 'PROJECT_NOT_FOUND', '项目不存在。');
    if (write && project.archived) fail(409, 'PROJECT_ARCHIVED', archivedMessage);
    return { project, role };
}

export function assertProjectAdminRemovable(db, projectId, targetUserId, nextRole) {
    if (nextRole === 'admin') return;
    const target = db.prepare(`SELECT membership.role,employee.active,employee.deleted_at
        FROM project_members membership JOIN users employee ON employee.id=membership.user_id
        WHERE membership.project_id=? AND membership.user_id=?`).get(projectId, targetUserId);
    if (target?.role !== 'admin' || !target.active || target.deleted_at !== null) return;
    const remaining = db.prepare(`SELECT COUNT(*) AS count FROM project_members membership JOIN users employee ON employee.id=membership.user_id
        WHERE membership.project_id=? AND membership.user_id<>? AND membership.role='admin'
        AND employee.active=1 AND employee.deleted_at IS NULL`).get(projectId, targetUserId).count;
    if (!remaining) fail(409, 'LAST_PROJECT_ADMIN', '请先指定另一位有效的项目管理员。');
}

export function requireProjectAdmin(db, user, projectId) {
    const role = requireProjectMember(db, user, projectId);
    if (role !== 'admin') fail(403, 'PROJECT_ADMIN_REQUIRED', '此操作需要项目管理员权限。');
    requireReadyEmployee(db, user);
    return role;
}

export function requireSystemAdmin(user) {
    if (user?.systemRole !== 'admin') fail(403, 'SYSTEM_ADMIN_REQUIRED', '此操作需要系统管理员权限。');
    if (user.mustChangePassword) fail(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
}

export function audit(db, user, action, targetType, targetId, details = {}) {
    const safe = {};
    for (const [name, value] of Object.entries(details)) {
        if (/password|secret|token|content|prompt|message|body|query|text/i.test(name)) continue;
        if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
            || typeof value === 'string' && value.length <= 200 || value === null) safe[name] = value;
    }
    db.prepare('INSERT INTO audit_records(id,actor_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), user.id, action, targetType, String(targetId), JSON.stringify(safe), Date.now());
}
