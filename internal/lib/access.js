import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

export function publicUser(row, db) {
    const mfaRequired = row.system_role === 'admin' || Boolean(db && db.prepare("SELECT 1 FROM project_members WHERE user_id=? AND role='admin' LIMIT 1").get(row.id));
    return { id: row.id, username: row.username, displayName: row.display_name,
        systemRole: row.system_role, autoMemoryEnabled: Boolean(row.auto_memory_enabled),
        mustChangePassword: Boolean(row.must_change_password), mfaEnabled: Boolean(row.mfa_secret), mfaRequired };
}

export function projectRole(db, user, projectId) {
    if (!user?.id || !projectId) return null;
    const membership = db.prepare(`SELECT membership.role FROM project_members membership
        JOIN users employee ON employee.id=membership.user_id
        JOIN projects project ON project.id=membership.project_id
        WHERE membership.project_id=? AND membership.user_id=? AND employee.active=1`).get(projectId, user.id);
    return membership?.role || null;
}

export function requireProjectMember(db, user, projectId) {
    const role = projectRole(db, user, projectId);
    if (!role) fail(403, 'PROJECT_ACCESS_DENIED', '你没有这个项目的访问权限。');
    return role;
}

export function requireProjectAdmin(db, user, projectId) {
    const role = requireProjectMember(db, user, projectId);
    if (role !== 'admin') fail(403, 'PROJECT_ADMIN_REQUIRED', '此操作需要项目管理员权限。');
    const actor = db.prepare('SELECT must_change_password,mfa_secret FROM users WHERE id=?').get(user.id);
    if (actor.must_change_password) fail(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
    if (!actor.mfa_secret) fail(428, 'MFA_SETUP_REQUIRED', '请先设置管理员二次验证。');
    return role;
}

export function requireSystemAdmin(user) {
    if (user?.systemRole !== 'admin') fail(403, 'SYSTEM_ADMIN_REQUIRED', '此操作需要系统管理员权限。');
    if (user.mustChangePassword) fail(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
    if (!user.mfaEnabled) fail(428, 'MFA_SETUP_REQUIRED', '请先设置管理员二次验证。');
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
