import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { audit, requireProjectAdmin, requireSystemAdmin } from './access.js';
import { fail } from './errors.js';
import { MEMORY_SCOPES, normalized } from './memory-store.js';
import { KNOWLEDGE_LIMITS } from './knowledge-parser.js';
import { schema, fileFields } from './knowledge-store.js';
import { createKnowledgeAccess } from './knowledge-access.js';
import { createKnowledgeEmbedding, createKnowledgeJobs } from './knowledge-jobs.js';
import { createKnowledgeRetrieval } from './knowledge-retrieval.js';

const MIMES = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function inputObject(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_KNOWLEDGE_INPUT', '资料操作参数无效。');
    return value;
}

export function createKnowledgeService({ db, config, provider }) {
    schema(db);
    const router = express.Router();
    const model = String(config.embeddingModel || 'BAAI/bge-m3');
    const rates = new Map();
    const access = createKnowledgeAccess({ db });
    const { employee, project, scopeInput, visible, publicFile, byId, writeAccess } = access;
    const embed = createKnowledgeEmbedding({ config, provider });
    const jobs = createKnowledgeJobs({ db, model, access, embed });
    const { retrieve, revalidate } = createKnowledgeRetrieval({ db, model, access, embed });
    const schedule = jobs.schedule;
    router.get('/knowledge/files', (request, response) => {
        employee(request.user);
        const { scope, projectId } = scopeInput(request.query, request.user);
        if (request.query.q !== undefined && (typeof request.query.q !== 'string' || request.query.q.length > 200)) fail(400, 'INVALID_KNOWLEDGE_INPUT', '搜索条件无效。');
        const query = normalized(request.query.q || '');
        const rows = db.prepare(`SELECT ${fileFields()} FROM knowledge_files WHERE scope=? AND project_id IS ? AND status<>'deleted'
            AND (?='project_shared' OR user_id=?) ORDER BY updated_at DESC,id`).all(scope, projectId, scope, request.user.id)
            .filter(row => visible(row, request.user) && (!query || normalized(row.name + '\n' + row.text_content).includes(query)));
        response.json({ files: rows.map(row => publicFile(row, request.user)), limits: KNOWLEDGE_LIMITS });
    });

    function uploadGuard(request, response, next) {
        try {
            employee(request.user);
            const values = scopeInput(request.query, request.user, true);
            const name = request.query.name;
            if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(name) || name === '.' || name === '..') fail(400, 'INVALID_KNOWLEDGE_NAME', '文件名需为 1–180 字，不能包含路径。');
            const extension = name.split('.').pop().toLowerCase();
            if (!name.includes('.') || !KNOWLEDGE_LIMITS.extensions.includes(extension)) fail(415, 'KNOWLEDGE_UNSUPPORTED_TYPE', '支持 TXT、MD、CSV、JSON、PDF、DOCX 和 XLSX 文件。');
            if (!request.is('application/octet-stream')) fail(415, 'KNOWLEDGE_UPLOAD_TYPE', '请使用文件上传入口。');
            if (values.scope === 'project_shared' && values.currentProject.role === 'admin') requireProjectAdmin(db, request.user, values.projectId);
            request.knowledgeUpload = { ...values, name: name.trim(), extension };
            next();
        } catch (error) { next(error); }
    }
    const rawUpload = express.raw({ type: 'application/octet-stream', limit: KNOWLEDGE_LIMITS.maxBytes });
    router.post('/knowledge/files', uploadGuard, rawUpload, (request, response) => {
        employee(request.user);
        const { scope, projectId, name, extension } = request.knowledgeUpload;
        const currentProject = projectId ? project(request.user, projectId, true) : null;
        if (scope === 'project_shared' && currentProject.role === 'admin') requireProjectAdmin(db, request.user, projectId);
        if (!Buffer.isBuffer(request.body) || !request.body.length) fail(400, 'KNOWLEDGE_EMPTY_FILE', '请选择非空文件。');
        if (request.body.length > KNOWLEDGE_LIMITS.maxBytes) fail(413, 'KNOWLEDGE_FILE_LIMIT', '单个文件不能超过 10 MB。');
        const now = Date.now();
        for (const [id, times] of rates) if (!times.some(time => time > now - 60000)) rates.delete(id);
        const times = (rates.get(request.user.id) || []).filter(time => time > now - 60000);
        if (times.length >= 20 || rates.size > 2048 && !rates.has(request.user.id)) fail(429, 'KNOWLEDGE_UPLOAD_RATE', '上传过于频繁，请稍后再试。');
        times.push(now); rates.set(request.user.id, times);
        const row = db.transaction(() => {
            const count = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_files WHERE scope=? AND project_id IS ? AND status<>'deleted' AND (?='project_shared' OR user_id=?)`)
                .get(scope, projectId, scope, request.user.id).count;
            if (count >= KNOWLEDGE_LIMITS.maxFiles) fail(409, 'KNOWLEDGE_FILE_COUNT_LIMIT', '这个资料范围已达到 40 个文件，请删除不再需要的文件。');
            const total = db.prepare(`SELECT COALESCE(SUM(size_bytes),0) AS total FROM knowledge_files WHERE user_id=? AND status<>'deleted'`).get(request.user.id).total;
            if (total + request.body.length > 200 * 1024 * 1024) fail(409, 'KNOWLEDGE_STORAGE_LIMIT', '你的文件总量已达到 200 MB，请清理不再需要的文件。');
            const id = randomUUID();
            db.prepare(`INSERT INTO knowledge_files(id,scope,user_id,project_id,name,extension,mime_type,size_bytes,sha256,original,status,processing_state,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, scope, request.user.id, projectId, name, extension, MIMES[extension], request.body.length,
                createHash('sha256').update(request.body).digest('hex'), request.body,
                scope === 'project_shared' && currentProject.role !== 'admin' ? 'candidate' : 'active', now, now);
            audit(db, request.user, 'knowledge.upload', 'knowledge_file', id, { scope, projectId, sizeBytes: request.body.length });
            return db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=?').get(id);
        })();
        schedule();
        response.status(201).json({ file: publicFile(row, request.user) });
    });
    router.get('/knowledge/files/:id', (request, response) => {
        const row = byId(request.params.id, request.user);
        response.json({ file: publicFile(row, request.user), text: row.text_content.slice(0, 12000) });
    });
    router.get('/knowledge/files/:id/download', (request, response) => {
        const row = byId(request.params.id, request.user);
        const original = db.prepare('SELECT original FROM knowledge_files WHERE id=?').get(row.id)?.original;
        if (!original) fail(404, 'KNOWLEDGE_NOT_FOUND', '原文件不存在。');
        audit(db, request.user, 'knowledge.download', 'knowledge_file', row.id, { scope: row.scope, projectId: row.project_id });
        response.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename=\"document." + row.extension + "\"; filename*=UTF-8''" + encodeURIComponent(row.name),
            'Content-Length': String(original.length), 'Cache-Control': 'no-store' }).send(original);
    });
    router.post('/knowledge/files/:id/retry', (request, response) => {
        const row = byId(request.params.id, request.user);
        inputObject(request.body || {}, []); writeAccess(row, request.user);
        if (row.status === 'rejected') fail(409, 'KNOWLEDGE_REJECTED', '未通过的资料不能继续处理，请重新上传修订版。');
        if (!['failed', 'interrupted'].includes(row.processing_state) && row.index_state !== 'failed') fail(409, 'KNOWLEDGE_NOT_RETRYABLE', '文件正在处理或已就绪，无需重试。');
        db.prepare(`UPDATE knowledge_files SET processing_state=?,index_state='queued',error_code=NULL,updated_at=? WHERE id=?`)
            .run(row.processing_state === 'ready' ? 'ready' : 'queued', Date.now(), row.id);
        audit(db, request.user, 'knowledge.retry', 'knowledge_file', row.id); schedule();
        response.json({ file: publicFile(db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=?').get(row.id), request.user) });
    });
    router.post('/knowledge/files/:id/review', (request, response) => {
        const row = byId(request.params.id, request.user);
        const input = inputObject(request.body, ['decision']);
        if (row.scope !== 'project_shared' || row.status !== 'candidate') fail(409, 'KNOWLEDGE_NOT_PENDING', '这个文件不在待审核状态。');
        project(request.user, row.project_id, true); requireProjectAdmin(db, request.user, row.project_id);
        if (!['approve', 'reject'].includes(input.decision)) fail(400, 'INVALID_KNOWLEDGE_REVIEW', '请选择通过或拒绝。');
        if (input.decision === 'approve' && row.processing_state !== 'ready') fail(409, 'KNOWLEDGE_NOT_READY', '请等待文件解析完成后再确认共享。');
        if (input.decision === 'approve') db.prepare("UPDATE knowledge_files SET status='active',updated_at=? WHERE id=?").run(Date.now(), row.id);
        else db.prepare(`UPDATE knowledge_files SET status='rejected',version=version+1,
            processing_state=CASE WHEN processing_state IN ('queued','running') THEN 'interrupted' ELSE processing_state END,
            index_state=CASE WHEN index_state='running' THEN 'failed' ELSE index_state END,error_code=NULL,updated_at=? WHERE id=?`).run(Date.now(), row.id);
        audit(db, request.user, 'knowledge.' + input.decision, 'knowledge_file', row.id, { scope: row.scope, projectId: row.project_id }); schedule();
        response.json({ file: publicFile(db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=?').get(row.id), request.user) });
    });
    router.delete('/knowledge/files/:id', (request, response) => {
        const row = byId(request.params.id, request.user); writeAccess(row, request.user);
        db.transaction(() => {
            db.prepare(`UPDATE knowledge_files SET status='deleted',original=NULL,text_content='',version=version+1,chunk_count=0,character_count=0,error_code=NULL,deleted_at=?,updated_at=? WHERE id=?`)
                .run(Date.now(), Date.now(), row.id);
            db.prepare('DELETE FROM knowledge_chunks WHERE file_id=?').run(row.id);
            audit(db, request.user, 'knowledge.delete', 'knowledge_file', row.id, { scope: row.scope, projectId: row.project_id });
        })();
        response.json({ ok: true });
    });

    function auditor(user) { const actor = employee(user); requireSystemAdmin(actor); return actor; }
    router.get('/admin/audit/files', (request, response) => {
        auditor(request.user);
        const values = [], clauses = ["file.status<>'deleted'"];
        for (const field of ['userId', 'projectId', 'q', 'scope']) {
            if (request.query[field] !== undefined && (typeof request.query[field] !== 'string' || request.query[field].length > 200)) fail(400, 'INVALID_AUDIT_FILTER', '查询条件无效。');
        }
        const limit = request.query.limit === undefined ? 50 : Number(request.query.limit), offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) fail(400, 'INVALID_PAGINATION', '分页参数无效。');
        if (request.query.userId) { clauses.push('file.user_id=?'); values.push(request.query.userId); }
        if (request.query.projectId) { clauses.push('file.project_id=?'); values.push(request.query.projectId); }
        if (request.query.scope) {
            if (!MEMORY_SCOPES.includes(request.query.scope)) fail(400, 'INVALID_AUDIT_FILTER', '资料范围无效。');
            clauses.push('file.scope=?'); values.push(request.query.scope);
        }
        const times = {};
        for (const field of ['from', 'to']) {
            const value = request.query[field];
            if (value === undefined || value === '') continue;
            if (typeof value !== 'string' || value.length > 40) fail(400, 'INVALID_AUDIT_FILTER', '时间范围无效。');
            times[field] = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
            if (!Number.isSafeInteger(times[field]) || times[field] < 0) fail(400, 'INVALID_AUDIT_FILTER', '时间范围无效。');
        }
        if (times.from !== undefined && times.to !== undefined && times.from > times.to) fail(400, 'INVALID_AUDIT_FILTER', '开始时间不能晚于结束时间。');
        if (times.from !== undefined) { clauses.push('file.updated_at>=?'); values.push(times.from); }
        if (times.to !== undefined) { clauses.push('file.updated_at<=?'); values.push(times.to); }
        if (request.query.q) {
            clauses.push("(file.name LIKE ? ESCAPE '\\' OR file.text_content LIKE ? ESCAPE '\\')");
            const like = '%' + request.query.q.replace(/[\\%_]/g, character => '\\' + character) + '%'; values.push(like, like);
        }
        const rows = db.prepare('SELECT ' + fileFields('file') + ' FROM knowledge_files file WHERE ' + clauses.join(' AND ') + ' ORDER BY file.updated_at DESC,file.id LIMIT ? OFFSET ?').all(...values, limit + 1, offset);
        audit(db, request.user, 'audit.files_list', 'knowledge_files', '*', { count: Math.min(limit, rows.length), offset });
        response.json({ files: rows.slice(0, limit).map(row => publicFile(row, request.user, true)), hasMore: rows.length > limit });
    });
    router.get('/admin/audit/files/:id', (request, response) => {
        auditor(request.user);
        const row = db.prepare(`SELECT ${fileFields()} FROM knowledge_files WHERE id=? AND status<>'deleted'`).get(request.params.id);
        if (!row) fail(404, 'KNOWLEDGE_NOT_FOUND', '文件不存在或已删除。');
        audit(db, request.user, 'audit.file_read', 'knowledge_file', row.id, { scope: row.scope, projectId: row.project_id });
        response.json({ file: publicFile(row, request.user, true), text: row.text_content.slice(0, 12000) });
    });

    return { router, start: jobs.start, async stop() { await jobs.stop(); rates.clear(); }, health: jobs.health, retrieve, revalidate };
}
