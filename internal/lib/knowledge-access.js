import { projectRole, requireProjectAdmin, requireReadyEmployee, requireProjectContext } from './access.js';
import { fail } from './errors.js';
import { MEMORY_SCOPES, controlRevision } from './memory-store.js';
import { fileFields, ERROR_MESSAGES } from './knowledge-store.js';

export function createKnowledgeAccess({ db }) {
    function employee(user) {
        return requireReadyEmployee(db, user).user;
    }
    function project(user, id, write = false) {
        const context = requireProjectContext(db, user, id, { write, archivedMessage: '归档项目为只读，不能修改资料。' });
        return { ...context.project, role: context.role };
    }
    function scopeInput(query, user, write = false) {
        const scope = query.scope === undefined ? 'personal' : query.scope;
        const projectId = query.projectId === undefined || query.projectId === '' ? null : query.projectId;
        if (typeof scope !== 'string' || !MEMORY_SCOPES.includes(scope) || projectId !== null && (typeof projectId !== 'string' || projectId.length > 200)
            || scope === 'personal' && projectId || scope !== 'personal' && !projectId) fail(400, 'INVALID_KNOWLEDGE_SCOPE', '资料范围与项目不匹配。');
        const currentProject = projectId ? project(user, projectId, write) : null;
        return { scope, projectId, currentProject };
    }
    function visible(row, user) {
        if (!row || row.status === 'deleted') return false;
        if (row.scope === 'personal') return row.user_id === user.id;
        const role = projectRole(db, user, row.project_id);
        return Boolean(role && (row.scope === 'project_private' ? row.user_id === user.id : row.status === 'active' || role === 'admin' || row.user_id === user.id));
    }
    function canManage(row, user) {
        if (row.project_id && db.prepare('SELECT archived FROM projects WHERE id=?').get(row.project_id)?.archived) return false;
        return row.scope !== 'project_shared' ? row.user_id === user.id : projectRole(db, user, row.project_id) === 'admin'
            || row.user_id === user.id && ['candidate', 'rejected'].includes(row.status);
    }
    function publicFile(row, user, auditOnly = false) {
        const role = row.project_id ? projectRole(db, user, row.project_id) : null;
        const archived = row.project_id && db.prepare('SELECT archived FROM projects WHERE id=?').get(row.project_id)?.archived;
        const canDelete = !auditOnly && row.status !== 'deleted' && canManage(row, user);
        return { id: row.id, name: row.name, filename: row.name, scope: row.scope, projectId: row.project_id, userId: row.user_id,
            ownerName: db.prepare('SELECT display_name FROM users WHERE id=?').get(row.user_id)?.display_name || '',
            status: row.status, state: row.processing_state, indexState: row.index_state,
            size: row.size_bytes, mimeType: row.mime_type, chunkCount: row.chunk_count, characterCount: row.character_count,
            errorCode: row.error_code || null, errorMessage: ERROR_MESSAGES[row.error_code] || '',
            createdAt: row.created_at, updatedAt: row.updated_at,
            canDelete: Boolean(canDelete), canRetry: Boolean(canDelete && (['failed', 'interrupted'].includes(row.processing_state) || row.index_state === 'failed')),
            canReview: Boolean(!auditOnly && !archived && role === 'admin' && row.status === 'candidate' && row.processing_state === 'ready'),
            canDownload: Boolean(!auditOnly && row.status !== 'deleted' && (row.has_original || row.original)) };
    }
    function byId(id, user) {
        employee(user);
        const row = db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=?').get(id);
        if (!visible(row, user)) fail(404, 'KNOWLEDGE_NOT_FOUND', '文件不存在或无权访问。');
        return row;
    }
    function writeAccess(row, user) {
        if (row.project_id) project(user, row.project_id, true);
        if (!canManage(row, user)) fail(403, 'KNOWLEDGE_WRITE_DENIED', '你不能修改这个范围内的资料。');
        if (row.scope === 'project_shared' && projectRole(db, user, row.project_id) === 'admin') requireProjectAdmin(db, user, row.project_id);
    }
    function controls(user, projectId) {
        return [controlRevision(db, 'user:' + user.id), projectId ? controlRevision(db, 'membership:' + user.id + ':' + projectId) : 0,
            projectId ? controlRevision(db, 'project:' + projectId) : 0].join(':');
    }
    function projectOwned(row) {
        return row.scope === 'project_shared' && row.status === 'active';
    }
    function jobStamp(row) {
        return projectOwned(row) ? 'project:' + controlRevision(db, 'project:' + row.project_id)
            : 'author:' + controls({ id: row.user_id }, row.project_id);
    }
    function eligible(row, version, stamp) {
        const fresh = db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=? AND version=? AND status=? AND status IN (\'active\',\'candidate\')').get(row.id, version, row.status);
        if (!fresh) return null;
        try {
            if (projectOwned(fresh)) {
                if (!db.prepare('SELECT id FROM projects WHERE id=? AND archived=0').get(fresh.project_id)) return null;
            } else {
                const user = employee({ id: fresh.user_id });
                if (fresh.project_id) project(user, fresh.project_id, true);
            }
            if (jobStamp(fresh) !== stamp) return null;
            return fresh;
        } catch { return null; }
    }
    return { employee, project, scopeInput, visible, canManage, publicFile, byId, writeAccess, controls, projectOwned, jobStamp, eligible };
}
