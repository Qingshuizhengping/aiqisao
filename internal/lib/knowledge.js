import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { audit, projectRole, publicUser, requireProjectMember, requireProjectAdmin, requireSystemAdmin } from './access.js';
import { fail } from './errors.js';
import { MEMORY_SCOPES, controlRevision, normalized, readVector, sensitive, vectorBuffer } from './memory-store.js';
import { KNOWLEDGE_LIMITS, PARSER_MESSAGES, chunkKnowledgeText, parseKnowledgeFile } from './knowledge-parser.js';

const MIMES = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const ERROR_MESSAGES = { ...PARSER_MESSAGES, KNOWLEDGE_SECRET_BLOCKED: '文件含有密码、密钥或验证码，不能加入检索资料库。请移除敏感凭据后重新上传。',
    KNOWLEDGE_ACCESS_CHANGED: '账号或项目权限已改变，处理已停止。恢复权限后可以重试。' };
const METADATA_COLUMNS = ['id', 'scope', 'user_id', 'project_id', 'name', 'extension', 'mime_type', 'size_bytes', 'sha256',
    'text_content', 'status', 'processing_state', 'index_state', 'error_code', 'version', 'chunk_count', 'character_count',
    'created_at', 'updated_at', 'deleted_at'];
function fileFields(alias = '') {
    const prefix = alias ? alias + '.' : '';
    return METADATA_COLUMNS.map(column => prefix + column).join(',') + ',' + prefix + 'original IS NOT NULL AS has_original';
}

function schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_files (
        id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','project_private','project_shared')),
        user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id),
        name TEXT NOT NULL, extension TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL, original BLOB, text_content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('active','candidate','rejected','deleted')),
        processing_state TEXT NOT NULL CHECK(processing_state IN ('queued','running','ready','failed','interrupted')),
        index_state TEXT NOT NULL DEFAULT 'queued' CHECK(index_state IN ('queued','running','ready','failed')),
        error_code TEXT, version INTEGER NOT NULL DEFAULT 1, chunk_count INTEGER NOT NULL DEFAULT 0,
        character_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
        CHECK((scope='personal' AND project_id IS NULL) OR (scope<>'personal' AND project_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS knowledge_files_scope ON knowledge_files(scope,project_id,user_id,status);
    CREATE INDEX IF NOT EXISTS knowledge_files_queue ON knowledge_files(processing_state,index_state,status,created_at);
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY NOT NULL, file_id TEXT NOT NULL REFERENCES knowledge_files(id), file_version INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding BLOB, embedding_model TEXT, embedding_dimension INTEGER,
        UNIQUE(file_id,file_version,chunk_index)
    );
    CREATE INDEX IF NOT EXISTS knowledge_chunks_file ON knowledge_chunks(file_id,file_version);`);
}

function tokens(query) {
    const values = new Set(String(query).normalize('NFKC').toLowerCase().match(/[a-z\d_]{2,}|[\u3400-\u9fff]{2,}/g) || []);
    for (const value of [...values]) if (/^[\u3400-\u9fff]+$/.test(value)) {
        for (let index = 0; index < value.length - 1 && values.size < 100; index++) values.add(value.slice(index, index + 2));
    }
    return [...values].slice(0, 100);
}
function inputObject(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_KNOWLEDGE_INPUT', '资料操作参数无效。');
    return value;
}

export function createKnowledgeService({ db, config, provider }) {
    schema(db);
    const router = express.Router();
    const model = String(config.embeddingModel || 'BAAI/bge-m3');
    const rates = new Map();
    let started = false, stopping = false, timer = null, draining = null, controller = null;

    async function embed(texts, signal) {
        const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(config.embeddingTimeoutMs || 5000)]) : AbortSignal.timeout(config.embeddingTimeoutMs || 5000);
        bounded.throwIfAborted();
        let aborted;
        const interrupted = new Promise((resolve, reject) => {
            aborted = () => reject(bounded.reason || new Error('Embedding interrupted'));
            bounded.addEventListener('abort', aborted, { once: true });
        });
        try { return await Promise.race([provider.embed(texts, { signal: bounded }), interrupted]); }
        finally { bounded.removeEventListener('abort', aborted); }
    }

    function employee(user) {
        const row = user?.id && db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(user.id);
        if (!row) fail(401, 'AUTH_REQUIRED', '请重新登录。');
        const actor = publicUser(row, db);
        if (actor.mustChangePassword) fail(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
        if (actor.mfaRequired && !actor.mfaEnabled) fail(428, 'MFA_SETUP_REQUIRED', '请先设置管理员二次验证。');
        return actor;
    }
    function project(user, id, write = false) {
        const role = requireProjectMember(db, user, id);
        const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!row) fail(404, 'PROJECT_NOT_FOUND', '项目不存在。');
        if (write && row.archived) fail(409, 'PROJECT_ARCHIVED', '归档项目为只读，不能修改资料。');
        return { ...row, role };
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
    function eligible(row, version, stamp) {
        if (stopping) return null;
        const fresh = db.prepare('SELECT ' + fileFields() + ' FROM knowledge_files WHERE id=? AND version=? AND status IN (\'active\',\'candidate\')').get(row.id, version);
        if (!fresh) return null;
        try {
            const user = employee({ id: fresh.user_id });
            if (fresh.project_id) project(user, fresh.project_id, true);
            if (controls(user, fresh.project_id) !== stamp) return null;
            return fresh;
        } catch { return null; }
    }
    function schedule() {
        if (!started || stopping || timer || draining) return;
        timer = setTimeout(() => {
            timer = null;
            draining = drain().catch(() => {}).finally(() => { draining = null; if (hasQueued()) schedule(); });
        }, 0);
        timer.unref?.();
    }
    function hasQueued() {
        if (!started || stopping) return false;
        return Boolean(db.prepare(`SELECT 1 FROM knowledge_files WHERE status IN ('active','candidate') AND
            (processing_state='queued' OR (status='active' AND processing_state='ready' AND index_state='queued')) LIMIT 1`).get());
    }
    async function processFile(row) {
        const version = row.version;
        const stamp = controls({ id: row.user_id }, row.project_id);
        controller = new AbortController();
        try {
            if (!eligible(row, version, stamp)) fail(409, 'KNOWLEDGE_ACCESS_CHANGED', ERROR_MESSAGES.KNOWLEDGE_ACCESS_CHANGED);
            if (row.processing_state === 'queued') {
                db.prepare(`UPDATE knowledge_files SET processing_state='running',error_code=NULL,updated_at=? WHERE id=? AND version=?`).run(Date.now(), row.id, version);
                const original = db.prepare('SELECT original FROM knowledge_files WHERE id=? AND version=?').get(row.id, version)?.original;
                const text = await parseKnowledgeFile({ name: row.name, bytes: original, signal: controller.signal });
                if (!eligible(row, version, stamp)) fail(409, 'KNOWLEDGE_ACCESS_CHANGED', ERROR_MESSAGES.KNOWLEDGE_ACCESS_CHANGED);
                if (sensitive(text)) fail(422, 'KNOWLEDGE_SECRET_BLOCKED', ERROR_MESSAGES.KNOWLEDGE_SECRET_BLOCKED);
                const chunks = chunkKnowledgeText(text);
                db.transaction(() => {
                    db.prepare('DELETE FROM knowledge_chunks WHERE file_id=?').run(row.id);
                    const insert = db.prepare('INSERT INTO knowledge_chunks(id,file_id,file_version,chunk_index,content) VALUES(?,?,?,?,?)');
                    chunks.forEach((content, index) => insert.run(randomUUID(), row.id, version, index, content));
                    db.prepare(`UPDATE knowledge_files SET text_content=?,character_count=?,chunk_count=?,processing_state='ready',index_state='queued',error_code=NULL,updated_at=? WHERE id=? AND version=?`)
                        .run(text, text.length, chunks.length, Date.now(), row.id, version);
                })();
            }
            let fresh = eligible(row, version, stamp);
            if (!fresh || fresh.status !== 'active') return;
            db.prepare(`UPDATE knowledge_files SET index_state='running',error_code=NULL,updated_at=? WHERE id=? AND version=?`).run(Date.now(), row.id, version);
            const chunks = db.prepare('SELECT * FROM knowledge_chunks WHERE file_id=? AND file_version=? ORDER BY chunk_index').all(row.id, version);
            for (let offset = 0; offset < chunks.length; offset += 8) {
                const batch = chunks.slice(offset, offset + 8);
                const vectors = await embed(batch.map(chunk => chunk.content), controller.signal);
                if (!eligible(row, version, stamp)) fail(409, 'KNOWLEDGE_ACCESS_CHANGED', ERROR_MESSAGES.KNOWLEDGE_ACCESS_CHANGED);
                if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('Invalid vectors');
                const converted = vectors.map(vector => ({ bytes: vectorBuffer(vector), dimension: vector.length }));
                if (converted.some(vector => vector.dimension !== converted[0].dimension)) throw new Error('Invalid vector dimensions');
                db.transaction(() => {
                    batch.forEach((chunk, index) => db.prepare('UPDATE knowledge_chunks SET embedding=?,embedding_model=?,embedding_dimension=? WHERE id=? AND file_version=?')
                        .run(converted[index].bytes, model, converted[index].dimension, chunk.id, version));
                })();
            }
            if (eligible(row, version, stamp)) db.prepare(`UPDATE knowledge_files SET index_state='ready',error_code=NULL,updated_at=? WHERE id=? AND version=?`).run(Date.now(), row.id, version);
        } catch (error) {
            const fresh = db.prepare('SELECT processing_state FROM knowledge_files WHERE id=? AND version=? AND status<>\'deleted\'').get(row.id, version);
            if (!fresh) return;
            const code = stopping ? 'KNOWLEDGE_INTERRUPTED' : ERROR_MESSAGES[error.code] ? error.code : fresh.processing_state === 'ready' ? 'KNOWLEDGE_INDEX_FAILED' : 'KNOWLEDGE_PARSE_FAILED';
            db.prepare(`UPDATE knowledge_files SET processing_state=?,index_state='failed',error_code=?,updated_at=? WHERE id=? AND version=? AND status<>'deleted'`)
                .run(fresh.processing_state === 'ready' ? 'ready' : stopping ? 'interrupted' : 'failed', code, Date.now(), row.id, version);
        } finally { controller = null; }
    }
    async function drain() {
        while (!stopping) {
            const row = db.prepare(`SELECT ${fileFields()} FROM knowledge_files WHERE status IN ('active','candidate') AND
                (processing_state='queued' OR (status='active' AND processing_state='ready' AND index_state='queued')) ORDER BY created_at,id LIMIT 1`).get();
            if (!row) break;
            await processFile(row);
        }
    }
    function availableChunks(user, projectId) {
        return db.prepare(`SELECT chunk.*,file.name,file.scope,file.user_id,file.project_id,file.updated_at FROM knowledge_chunks chunk
            JOIN knowledge_files file ON file.id=chunk.file_id AND file.version=chunk.file_version
            WHERE file.status='active' AND file.processing_state='ready' AND
            ((file.scope='personal' AND file.user_id=? AND file.project_id IS NULL) OR
            (file.project_id=? AND ((file.scope='project_private' AND file.user_id=?) OR file.scope='project_shared')))
            ORDER BY file.updated_at DESC,chunk.chunk_index LIMIT 12000`).all(user.id, projectId, user.id);
    }
    function revalidate({ user, projectId = null, references = [] }) {
        employee(user);
        if (projectId) project(user, projectId);
        if (!Array.isArray(references) || !references.length) return [];
        const rows = new Map(availableChunks(user, projectId).map(row => [row.id, row]));
        return references.flatMap(reference => {
            const row = rows.get(reference.id);
            if (!row || row.file_version !== reference.version || row.file_id !== reference.fileId) return [];
            return [{ id: row.id, fileId: row.file_id, filename: row.name, scope: row.scope, projectId: row.project_id || null,
                version: row.file_version, content: row.content, chunkIndex: row.chunk_index }];
        });
    }
    async function retrieve({ user, projectId = null, query }) {
        employee(user);
        if (projectId) project(user, projectId);
        let rows = availableChunks(user, projectId);
        if (!rows.length || typeof query !== 'string' || !query.trim()) return { references: [], degraded: false };
        const stamp = controls(user, projectId);
        let vector = null, degraded = false;
        try {
            if (sensitive(query)) throw new Error('Sensitive query is keyword only');
            const vectors = await embed([query.slice(0, 8000)]);
            if (!Array.isArray(vectors) || vectors.length !== 1) throw new Error('Invalid query vector');
            vector = readVector(vectorBuffer(vectors[0]), vectors[0].length);
        } catch { degraded = true; }
        employee(user);
        if (projectId) project(user, projectId);
        if (controls(user, projectId) !== stamp) return { references: [], degraded: true };
        const fresh = new Map(availableChunks(user, projectId).map(row => [row.id, row.file_version]));
        rows = rows.filter(row => fresh.get(row.id) === row.file_version);
        const words = tokens(query);
        const ranked = rows.map(row => {
            const text = normalized(row.content + ' ' + row.name);
            const lexical = words.length ? words.filter(word => text.includes(normalized(word))).length / words.length : 0;
            let semantic = 0;
            const indexed = vector && row.embedding_model === model && row.embedding_dimension === vector.length ? readVector(row.embedding, row.embedding_dimension) : null;
            if (indexed) semantic = Math.max(0, indexed.reduce((score, value, index) => score + value * vector[index], 0));
            else degraded = true;
            return { row, score: lexical * 0.45 + semantic * 0.55, lexical, semantic };
        }).filter(value => value.lexical > 0 || value.semantic >= 0.25).sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at);
        const selected = [];
        let used = 0;
        for (const { row } of ranked) {
            if (selected.length >= 8 || used + row.content.length > 7000) continue;
            selected.push({ id: row.id, fileId: row.file_id, filename: row.name, scope: row.scope, projectId: row.project_id || null,
                version: row.file_version, content: row.content, chunkIndex: row.chunk_index });
            used += row.content.length;
        }
        return { references: revalidate({ user, projectId, references: selected }), degraded };
    }

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
        db.prepare('UPDATE knowledge_files SET status=?,updated_at=? WHERE id=?').run(input.decision === 'approve' ? 'active' : 'rejected', Date.now(), row.id);
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

    function start() {
        if (started) return;
        stopping = false; started = true;
        db.prepare(`UPDATE knowledge_files SET processing_state='interrupted',index_state='failed',error_code='KNOWLEDGE_INTERRUPTED',updated_at=? WHERE processing_state='running' AND status<>'deleted'`).run(Date.now());
        db.prepare(`UPDATE knowledge_files SET index_state='failed',error_code='KNOWLEDGE_INTERRUPTED',updated_at=? WHERE index_state='running' AND status<>'deleted'`).run(Date.now());
        schedule();
    }
    async function stop() {
        stopping = true; started = false;
        if (timer) clearTimeout(timer); timer = null;
        controller?.abort(); await draining; rates.clear();
    }
    function health() {
        return { ready: true, running: Boolean(draining), queued: db.prepare(`SELECT COUNT(*) AS count FROM knowledge_files WHERE status IN ('active','candidate') AND
            (processing_state='queued' OR (status='active' AND processing_state='ready' AND index_state='queued'))`).get().count,
            failed: db.prepare(`SELECT COUNT(*) AS count FROM knowledge_files WHERE status<>'deleted' AND (processing_state IN ('failed','interrupted') OR index_state='failed')`).get().count };
    }
    return { router, start, stop, health, retrieve, revalidate };
}
