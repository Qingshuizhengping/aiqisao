import express from 'express';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { audit, projectRole, publicUser, requireProjectMember, requireProjectAdmin, requireReadyEmployee, requireProjectContext } from './access.js';
import { MEMORY_SCOPES, contentValue, normalized, sensitive, fingerprint, scopeKey, controlRevision,
    bumpControl, vectorBuffer, readVector, initializeMemorySchema, insertMemory } from './memory-store.js';

function objectInput(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
        fail(400, 'INVALID_MEMORY_INPUT', '记忆操作参数无效。');
    }
    return value;
}

function keywordTokens(value) {
    const tokens = new Set(String(value).normalize('NFKC').toLowerCase().match(/[a-z\d_]{2,}|[\u3400-\u9fff]{2,}/g) || []);
    for (const text of [...tokens]) {
        if (/^[\u3400-\u9fff]+$/.test(text)) {
            for (let index = 0; index < text.length - 1 && tokens.size < 100; index++) tokens.add(text.slice(index, index + 2));
        }
    }
    return [...tokens].slice(0, 100);
}

function lexicalScore(query, content) {
    const tokens = keywordTokens(query);
    if (!tokens.length) return 0;
    const text = normalized(content);
    return tokens.filter(token => text.includes(normalized(token))).length / tokens.length;
}

export function createMemoryService({ db, config, provider }) {
    const router = express.Router();
    const search = initializeMemorySchema(db);
    const embeddingModel = String(config.embeddingModel || 'BAAI/bge-m3');
    let started = false;
    let stopping = false;
    let timer = null;
    let draining = null;
    let activeController = null;
    const queryCache = new Map();

    function employee(user) {
        return requireReadyEmployee(db, user).row;
    }

    function project(user, projectId, write = false) {
        const context = requireProjectContext(db, user, projectId, { write, archivedMessage: '归档项目为只读，不能修改记忆。' });
        return { ...context.project, role: context.role };
    }

    function visible(row, user) {
        if (!row || row.status === 'deleted') return false;
        if (row.scope !== 'project_shared') {
            if (row.user_id !== user.id) return false;
            return row.scope === 'personal' || Boolean(projectRole(db, user, row.project_id));
        }
        const role = projectRole(db, user, row.project_id);
        return Boolean(role && (row.status === 'active' || role === 'admin' || row.user_id === user.id));
    }

    function publicMemory(row, user) {
        const role = row.project_id ? projectRole(db, user, row.project_id) : null;
        const own = row.user_id === user.id;
        const archived = row.project_id && db.prepare('SELECT archived FROM projects WHERE id=?').get(row.project_id)?.archived;
        const canEdit = !archived && (row.scope === 'project_shared' ? role === 'admin' : own);
        const canReadSource = own || Boolean(row.project_id && role === 'admin');
        const ownerName = db.prepare('SELECT display_name FROM users WHERE id=?').get(row.user_id)?.display_name || '';
        const index = db.prepare(`SELECT state FROM memory_index_jobs WHERE memory_id=? AND memory_version=? AND model=?`)
            .get(row.id, row.version, embeddingModel);
        const embeddingStatus = row.status !== 'active' ? 'not_required' : row.embedding && row.embedding_model === embeddingModel
            ? 'ready' : ['failed', 'interrupted'].includes(index?.state) ? 'failed' : index?.state === 'queued' || index?.state === 'running' ? 'queued' : 'missing';
        return { id: row.id, scope: row.scope, projectId: row.project_id, userId: row.user_id, ownerName,
            content: row.content, status: row.status, origin: row.origin, version: row.version,
            createdAt: row.created_at, updatedAt: row.updated_at,
            sourceConversationId: canReadSource ? row.source_conversation_id : null,
            sourceMessageId: canReadSource ? row.source_message_id : null,
            sourceEvidence: canReadSource ? row.source_evidence : null,
            conflictWithId: row.conflict_with_id,
            embeddingStatus, canEdit: Boolean(canEdit), canReview: Boolean(!archived && (row.status === 'candidate' || row.status === 'conflict')
                && (row.scope === 'project_shared' ? role === 'admin' : own)),
            canWithdraw: Boolean(!archived && own && row.scope === 'project_shared' && ['candidate', 'conflict'].includes(row.status)),
        };
    }

    function memoryById(id, user) {
        employee(user);
        const row = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
        if (!visible(row, user)) fail(404, 'MEMORY_NOT_FOUND', '记忆不存在或无权访问。');
        return row;
    }

    function schedule() {
        if (!started || stopping || timer || draining) return;
        timer = setTimeout(() => {
            timer = null;
            draining = drain().catch(() => {}).finally(() => { draining = null; scheduleIdle(); });
        }, 0);
        timer.unref?.();
    }

    function scheduleIdle() {
        if (!started || stopping || timer) return;
        const queued = db.prepare(`SELECT EXISTS(SELECT 1 FROM memory_jobs WHERE state='queued')
            OR EXISTS(SELECT 1 FROM memory_index_jobs WHERE state='queued') AS queued`).get().queued;
        if (queued) schedule();
    }

    function queueIndex(row) {
        if (row.status !== 'active') return;
        const now = Date.now();
        db.prepare(`INSERT OR IGNORE INTO memory_index_jobs(id,memory_id,memory_version,model,state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), row.id, row.version, embeddingModel, 'queued', now, now);
        schedule();
    }

    function source(job) {
        const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(job.user_id);
        const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(job.conversation_id, job.user_id);
        if (!user || !user.auto_memory_enabled || !conversation || conversation.deleted_at || !conversation.memory_enabled) return null;
        const actor = publicUser(user, db);
        if (actor.mustChangePassword || actor.mfaRequired && !actor.mfaEnabled) return null;
        let currentProject = null;
        if (conversation.project_id) {
            if (!projectRole(db, { id: user.id }, conversation.project_id)) return null;
            currentProject = db.prepare('SELECT * FROM projects WHERE id=? AND archived=0').get(conversation.project_id);
            if (!currentProject) return null;
        }
        const userMessage = db.prepare(`SELECT * FROM messages WHERE id=? AND conversation_id=? AND role='user' AND status='complete'`)
            .get(job.user_message_id, conversation.id);
        const assistantMessage = db.prepare(`SELECT * FROM messages WHERE id=? AND conversation_id=? AND role='assistant' AND status='complete'`)
            .get(job.assistant_message_id, conversation.id);
        if (!userMessage || !assistantMessage || userMessage.created_at > assistantMessage.created_at) return null;
        const sourceHash = fingerprint(JSON.stringify([userMessage.id, userMessage.content, assistantMessage.id, assistantMessage.content]));
        if (job.source_hash && job.source_hash !== sourceHash) return null;
        if (sensitive(userMessage.content) || sensitive(assistantMessage.content)) return null;
        return { user, conversation, currentProject, userMessage, assistantMessage, sourceHash };
    }

    function snapshotControls(current) {
        const keys = ['user:' + current.user.id, 'conversation:' + current.conversation.id];
        if (current.currentProject) keys.push('project:' + current.currentProject.id, 'membership:' + current.user.id + ':' + current.currentProject.id);
        const scopes = current.currentProject ? ['project_private', 'project_shared'] : ['personal'];
        if (current.currentProject && /所有项目|任何项目|个人偏好|个人习惯|跨项目|无论.*项目|不管.*项目/.test(current.userMessage.content)) scopes.unshift('personal');
        return { base: Object.fromEntries(keys.map(key => [key, controlRevision(db, key)])),
            scopes: Object.fromEntries(scopes.map(scope => [scope, controlRevision(db, scopeKey(scope, current.user.id, current.currentProject?.id))])) };
    }

    function sourceState(job) {
        const current = source(job);
        if (!current) return null;
        const controls = JSON.parse(job.controls);
        if (Object.entries(controls.base).some(([key, revision]) => controlRevision(db, key) !== revision)) return null;
        const allowedScopes = Object.keys(controls.scopes).filter(scope =>
            controlRevision(db, scopeKey(scope, current.user.id, current.currentProject?.id)) === controls.scopes[scope]);
        return allowedScopes.length ? { ...current, allowedScopes, controls } : null;
    }

    function enqueueTurn(input) {
        objectInput(input, ['userId', 'conversationId', 'userMessageId', 'assistantMessageId']);
        const job = { user_id: input.userId, conversation_id: input.conversationId,
            user_message_id: input.userMessageId, assistant_message_id: input.assistantMessageId };
        const current = source(job);
        if (!current) return null;
        const existing = db.prepare('SELECT * FROM memory_jobs WHERE assistant_message_id=?').get(input.assistantMessageId);
        if (existing) return publicJob(existing);
        const now = Date.now();
        const id = randomUUID();
        db.prepare(`INSERT INTO memory_jobs(id,user_id,conversation_id,user_message_id,assistant_message_id,state,
            source_hash,controls,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, input.userId,
            input.conversationId, input.userMessageId, input.assistantMessageId, 'queued', current.sourceHash,
            JSON.stringify(snapshotControls(current)), now, now);
        schedule();
        return publicJob(db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(id));
    }

    function publicJob(row) {
        return { id: row.id, conversationId: row.conversation_id, state: row.state, attempts: row.attempts,
            errorCode: row.error_code, resultCount: row.result_count, createdAt: row.created_at, updatedAt: row.updated_at };
    }

    function parseExtraction(result, allowedScopes, current) {
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => key !== 'memories')
            || !Array.isArray(result.memories) || result.memories.length > 12) throw new Error('Invalid memory extraction');
        const seen = new Set();
        return result.memories.map(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).some(key => !['scope', 'content', 'key', 'conflictWithId', 'evidence'].includes(key))
                || !allowedScopes.includes(value.scope) || typeof value.content !== 'string'
                || typeof value.evidence !== 'string' || !value.evidence.trim() || value.evidence.length > 300
                || !current.userMessage.content.includes(value.evidence)
                || value.key !== undefined && (typeof value.key !== 'string' || !value.key.trim() || value.key.length > 160)
                || value.conflictWithId !== undefined && (typeof value.conflictWithId !== 'string' || value.conflictWithId.length > 80)) {
                throw new Error('Invalid memory extraction entry');
            }
            const content = contentValue(value.content);
            const userText = normalized(current.userMessage.content);
            if (/(?:保证有效|包治|根治|立即见效|医学认证|权威认证|销量第一)/.test(content)
                && !userText.includes(normalized(content))) throw new Error('Unsupported memory claim');
            const hash = fingerprint(value.scope + ':' + normalized(content));
            if (seen.has(hash)) return null;
            seen.add(hash);
            return { scope: value.scope, content, key: value.key?.trim() || normalized(content),
                evidence: value.evidence, conflictWithId: value.conflictWithId || null };
        }).filter(Boolean);
    }

    function scopedRows(current) {
        return db.prepare(`SELECT * FROM memories WHERE status IN ('active','candidate','conflict') AND
            ((scope='personal' AND user_id=? AND project_id IS NULL) OR
            (project_id=? AND ((scope='project_private' AND user_id=?) OR scope='project_shared')))
            ORDER BY updated_at DESC LIMIT 100`).all(current.user.id, current.currentProject?.id || null, current.user.id);
    }

    function saveExtracted(job, current, proposed) {
        return db.transaction(() => {
            const latest = sourceState(job);
            if (!latest) return null;
            let count = 0;
            for (const value of proposed) {
                if (!latest.allowedScopes.includes(value.scope)) continue;
                const projectId = value.scope === 'personal' ? null : latest.currentProject?.id;
                const rows = db.prepare(`SELECT * FROM memories WHERE scope=? AND project_id IS ?
                    AND (?='project_shared' OR user_id=?) ORDER BY updated_at DESC`).all(value.scope, projectId, value.scope, job.user_id);
                const hash = fingerprint(normalized(value.content));
                if (rows.some(row => row.content_hash === hash && ['active', 'candidate', 'conflict', 'deleted', 'rejected', 'inactive'].includes(row.status))) continue;
                const key = fingerprint(value.key);
                const sameKey = rows.find(row => row.key === key && row.status === 'active');
                const reference = value.conflictWithId ? rows.find(row => row.id === value.conflictWithId && row.status === 'active') : null;
                if (value.conflictWithId && !reference) throw new Error('Invalid conflict source');
                if (!sameKey && rows.some(row => row.key === key && ['deleted', 'rejected', 'inactive'].includes(row.status))) continue;
                const conflict = reference || sameKey;
                const status = conflict ? 'conflict' : value.scope === 'project_shared' ? 'candidate' : 'active';
                const row = insertMemory(db, { userId: job.user_id, projectId, scope: value.scope, content: value.content,
                    key: value.key, status, origin: 'automatic', sourceConversationId: job.conversation_id,
                    sourceMessageId: job.user_message_id, sourceEvidence: value.evidence, conflictWithId: conflict?.id || null });
                queueIndex(row);
                count++;
            }
            db.prepare(`UPDATE memory_jobs SET state='completed',result_count=?,error_code=NULL,updated_at=? WHERE id=?`)
                .run(count, Date.now(), job.id);
            return count;
        })();
    }

    async function processExtraction(job, signal) {
        const current = sourceState(job);
        if (!current) {
            db.prepare(`UPDATE memory_jobs SET state='skipped',error_code='MEMORY_SOURCE_CHANGED',updated_at=? WHERE id=?`).run(Date.now(), job.id);
            return;
        }
        const existing = scopedRows(current).filter(row => current.allowedScopes.includes(row.scope) && visible(row, { id: current.user.id }));
        const proposed = await provider.extractMemory({ userMessage: current.userMessage.content,
            assistantMessage: current.assistantMessage.content,
            project: current.currentProject ? { id: current.currentProject.id, name: current.currentProject.name,
                description: current.currentProject.description, instructions: current.currentProject.instructions } : null,
            existingMemories: existing.map(row => ({ id: row.id, scope: row.scope, content: row.content, status: row.status })),
            allowedScopes: current.allowedScopes }, { signal });
        if (signal.aborted) throw new Error('Memory service stopped');
        const parsed = parseExtraction(proposed, current.allowedScopes, current);
        if (saveExtracted(job, current, parsed) === null) {
            db.prepare(`UPDATE memory_jobs SET state='skipped',error_code='MEMORY_SOURCE_CHANGED',updated_at=? WHERE id=?`).run(Date.now(), job.id);
        }
    }

    function indexable(row) {
        if (!row || row.status !== 'active' || sensitive(row.content)) return false;
        if (row.scope === 'project_shared') return Boolean(db.prepare('SELECT id FROM projects WHERE id=? AND archived=0').get(row.project_id));
        const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(row.user_id);
        const actor = user && publicUser(user, db);
        return Boolean(actor && !actor.mustChangePassword && (!actor.mfaRequired || actor.mfaEnabled)
            && (row.scope === 'personal' || projectRole(db, actor, row.project_id)));
    }

    async function processIndex(job, signal) {
        let row = db.prepare('SELECT * FROM memories WHERE id=?').get(job.memory_id);
        if (!indexable(row) || row.version !== job.memory_version || job.model !== embeddingModel) {
            db.prepare(`UPDATE memory_index_jobs SET state='skipped',error_code='MEMORY_CHANGED',updated_at=? WHERE id=?`).run(Date.now(), job.id);
            return;
        }
        const vectors = await provider.embed([row.content], { signal });
        if (signal.aborted) throw new Error('Memory service stopped');
        if (!Array.isArray(vectors) || vectors.length !== 1) throw new Error('Invalid embedding response');
        const buffer = vectorBuffer(vectors[0]);
        db.transaction(() => {
            row = db.prepare('SELECT * FROM memories WHERE id=?').get(job.memory_id);
            if (!indexable(row) || row.version !== job.memory_version) {
                db.prepare(`UPDATE memory_index_jobs SET state='skipped',error_code='MEMORY_CHANGED',updated_at=? WHERE id=?`).run(Date.now(), job.id);
                return;
            }
            db.prepare('UPDATE memories SET embedding=?,embedding_model=?,embedding_dimension=? WHERE id=? AND version=?')
                .run(buffer, embeddingModel, vectors[0].length, row.id, row.version);
            db.prepare(`UPDATE memory_index_jobs SET state='completed',error_code=NULL,updated_at=? WHERE id=?`).run(Date.now(), job.id);
        })();
    }

    async function drain() {
        while (started && !stopping) {
            const extraction = db.prepare(`SELECT * FROM memory_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1`).get();
            const job = extraction || db.prepare(`SELECT * FROM memory_index_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1`).get();
            if (!job) return;
            const table = extraction ? 'memory_jobs' : 'memory_index_jobs';
            const changed = db.prepare(`UPDATE ${table} SET state='running',attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'`)
                .run(Date.now(), job.id).changes;
            if (!changed) continue;
            activeController = new AbortController();
            try {
                if (extraction) await processExtraction(job, activeController.signal);
                else await processIndex(job, activeController.signal);
            } catch {
                db.prepare(`UPDATE ${table} SET state=?,error_code=?,updated_at=? WHERE id=? AND state='running'`)
                    .run(stopping ? 'interrupted' : 'failed', stopping ? 'MEMORY_JOB_INTERRUPTED' : extraction ? 'MEMORY_EXTRACTION_FAILED' : 'MEMORY_INDEX_FAILED', Date.now(), job.id);
            } finally {
                activeController = null;
            }
        }
    }

    async function queryVector(user, projectId, query) {
        const key = fingerprint(JSON.stringify([user.id, projectId || null, embeddingModel, query]));
        const cached = queryCache.get(key);
        if (cached && cached.expires > Date.now()) return cached.promise;
        if (queryCache.size >= 128) queryCache.delete(queryCache.keys().next().value);
        const promise = Promise.resolve().then(() => provider.embed([query], {})).then(vectors => {
            if (!Array.isArray(vectors) || vectors.length !== 1) throw new Error('Invalid query embedding');
            const buffer = vectorBuffer(vectors[0]);
            return readVector(buffer, vectors[0].length);
        });
        queryCache.set(key, { promise, expires: Date.now() + 60000 });
        promise.catch(() => { if (queryCache.get(key)?.promise === promise) queryCache.delete(key); });
        return promise;
    }

    function revalidate({ user, projectId = null, memories = [] }) {
        employee(user);
        if (projectId) project(user, projectId);
        return memories.flatMap(reference => {
            const row = db.prepare('SELECT * FROM memories WHERE id=?').get(reference.id);
            if (!row || row.status !== 'active' || row.version !== reference.version || !visible(row, user)) return [];
            if (row.scope === 'personal' ? row.user_id !== user.id : row.project_id !== projectId) return [];
            return [publicMemory(row, user)];
        });
    }

    async function retrieve({ user, projectId = null, query }) {
        employee(user);
        if (projectId) project(user, projectId);
        if (typeof query !== 'string' || !query.trim()) return { memories: [], degraded: false };
        if (query.length > 16000) fail(400, 'QUERY_TOO_LONG', '查询内容过长。');
        let rows = db.prepare(`SELECT * FROM memories WHERE status='active' AND
            ((scope='personal' AND user_id=? AND project_id IS NULL) OR
            (project_id=? AND ((scope='project_private' AND user_id=?) OR scope='project_shared')))`)
            .all(user.id, projectId, user.id);
        if (!rows.length) return { memories: [], degraded: false };
        let vector = null;
        let degraded = !search.fullTextAvailable;
        if (sensitive(query)) degraded = true;
        else try { vector = await queryVector(user, projectId, query); } catch { degraded = true; }
        employee(user);
        if (projectId) project(user, projectId);
        const available = new Map(db.prepare(`SELECT id,version FROM memories WHERE status='active' AND
            ((scope='personal' AND user_id=? AND project_id IS NULL) OR
            (project_id=? AND ((scope='project_private' AND user_id=?) OR scope='project_shared')))`)
            .all(user.id, projectId, user.id).map(row => [row.id, row.version]));
        rows = rows.filter(row => available.get(row.id) === row.version);
        const matches = new Set();
        if (search.fullTextAvailable) {
            const tokens = keywordTokens(query).flatMap(token => {
                if (token.length < 3) return [];
                if (/^[\u3400-\u9fff]+$/.test(token)) return Array.from({ length: token.length - 2 }, (value, index) => token.slice(index, index + 3));
                return [token];
            }).slice(0, 40);
            if (tokens.length) {
                const expression = [...new Set(tokens)].map(token => '"' + token.replaceAll('"', '""') + '"').join(' OR ');
                for (const row of db.prepare(`SELECT memory_fts.memory_id FROM memory_fts JOIN memories memory ON memory.id=memory_fts.memory_id
                    WHERE memory_fts MATCH ? AND memory.status='active' AND
                    ((memory.scope='personal' AND memory.user_id=? AND memory.project_id IS NULL) OR
                    (memory.project_id=? AND ((memory.scope='project_private' AND memory.user_id=?) OR memory.scope='project_shared'))) LIMIT 100`)
                    .all(expression, user.id, projectId, user.id)) matches.add(row.memory_id);
            }
        }
        const ranked = rows.map(row => {
            let semantic = 0;
            const indexed = row.embedding_model === embeddingModel && row.embedding_dimension === vector?.length
                ? readVector(row.embedding, row.embedding_dimension) : null;
            if (vector && indexed) semantic = Math.max(0, indexed.reduce((total, value, index) => total + value * vector[index], 0));
            else {
                degraded = true;
                queueIndex(row);
            }
            const lexical = lexicalScore(query, row.content);
            const score = semantic * 0.75 + lexical * 0.25 + (matches.has(row.id) ? 0.1 : 0) + (row.origin === 'manual' ? 0.01 : 0);
            return { row, score, lexical, semantic };
        }).sort((first, second) => second.score - first.score || second.row.updated_at - first.row.updated_at);
        const selected = [];
        let characters = 0;
        for (const entry of ranked) {
            if (entry.score < 0.08 && !(entry.row.scope === 'personal' && selected.filter(row => row.scope === 'personal').length < 2)) continue;
            if (characters + entry.row.content.length > 6000 || selected.length >= 12) continue;
            selected.push(publicMemory(entry.row, user));
            characters += entry.row.content.length;
        }
        return { memories: selected, degraded, ...(degraded ? { code: 'MEMORY_RETRIEVAL_DEGRADED',
            warning: '部分记忆的语义索引暂不可用，已结合关键词和可用记忆继续回答。' } : {}) };
    }

    router.get('/memories', (request, response) => {
        employee(request.user);
        const scope = request.query.scope || 'personal';
        if (!MEMORY_SCOPES.includes(scope)) fail(400, 'INVALID_MEMORY_SCOPE', '记忆范围无效。');
        const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : null;
        if (scope !== 'personal' && !projectId) fail(400, 'PROJECT_REQUIRED', '请先选择项目。');
        if (scope === 'personal' && projectId) fail(400, 'INVALID_MEMORY_SCOPE', '个人记忆不属于项目。');
        if (projectId) project(request.user, projectId);
        const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 1000) : '';
        const rows = db.prepare(`SELECT * FROM memories WHERE scope=? AND project_id IS ? AND status<>'deleted'
            AND (?='project_shared' OR user_id=?) ORDER BY updated_at DESC`).all(scope, projectId, scope, request.user.id)
            .filter(row => visible(row, request.user) && (!query || normalized(row.content).includes(normalized(query))));
        response.json({ memories: rows.slice(0, 500).map(row => publicMemory(row, request.user)) });
    });

    router.post('/memories', (request, response) => {
        employee(request.user);
        const input = objectInput(request.body, ['scope', 'projectId', 'content']);
        if (!MEMORY_SCOPES.includes(input.scope)) fail(400, 'INVALID_MEMORY_SCOPE', '记忆范围无效。');
        const content = contentValue(input.content);
        const projectId = input.projectId || null;
        if (input.scope === 'personal' && projectId || input.scope !== 'personal' && !projectId) fail(400, 'INVALID_MEMORY_SCOPE', '记忆范围与项目不匹配。');
        const currentProject = projectId ? project(request.user, projectId, true) : null;
        if (input.scope === 'project_shared' && currentProject.role === 'admin') requireProjectAdmin(db, request.user, projectId);
        const row = db.transaction(() => {
            const created = insertMemory(db, { userId: request.user.id, projectId, scope: input.scope, content,
                status: input.scope === 'project_shared' && currentProject.role !== 'admin' ? 'candidate' : 'active' });
            bumpControl(db, scopeKey(input.scope, request.user.id, projectId));
            audit(db, request.user, 'memory.create', 'memory', created.id, { scope: input.scope, projectId });
            queueIndex(created);
            return created;
        })();
        response.status(201).json({ memory: publicMemory(row, request.user) });
    });

    router.patch('/memories/:id', (request, response) => {
        const row = memoryById(request.params.id, request.user);
        const input = objectInput(request.body, ['content', 'active']);
        if (!Object.keys(input).length || input.active !== undefined && typeof input.active !== 'boolean') fail(400, 'INVALID_MEMORY_INPUT', '记忆操作参数无效。');
        if (row.project_id) project(request.user, row.project_id, true);
        if (row.scope === 'project_shared') requireProjectAdmin(db, request.user, row.project_id);
        const content = input.content === undefined ? row.content : contentValue(input.content);
        if (input.active === true && ['candidate', 'conflict', 'rejected'].includes(row.status)) fail(409, 'MEMORY_REVIEW_REQUIRED', '请通过审核操作确认这条候选记忆。');
        const now = Date.now();
        db.transaction(() => {
            db.prepare(`UPDATE memories SET content=?,content_hash=?,key=?,status=?,origin='manual',source_evidence='',version=version+1,
                embedding=NULL,embedding_model=NULL,embedding_dimension=NULL,updated_at=? WHERE id=?`).run(content,
                fingerprint(normalized(content)), row.key,
                input.active === false ? 'inactive' : input.active === true ? 'active' : row.status, now, row.id);
            bumpControl(db, scopeKey(row.scope, row.user_id, row.project_id));
            audit(db, request.user, 'memory.update', 'memory', row.id, { scope: row.scope, projectId: row.project_id });
        })();
        const updated = db.prepare('SELECT * FROM memories WHERE id=?').get(row.id);
        queueIndex(updated);
        response.json({ memory: publicMemory(updated, request.user) });
    });

    router.delete('/memories/:id', (request, response) => {
        const row = memoryById(request.params.id, request.user);
        if (row.project_id) project(request.user, row.project_id, true);
        if (row.scope === 'project_shared' && !(row.user_id === request.user.id && ['candidate', 'conflict'].includes(row.status))) {
            requireProjectAdmin(db, request.user, row.project_id);
        }
        db.transaction(() => {
            db.prepare(`UPDATE memories SET content='',source_evidence='',status='deleted',version=version+1,embedding=NULL,
                embedding_model=NULL,embedding_dimension=NULL,deleted_at=?,updated_at=? WHERE id=?`).run(Date.now(), Date.now(), row.id);
            bumpControl(db, scopeKey(row.scope, row.user_id, row.project_id));
            audit(db, request.user, 'memory.delete', 'memory', row.id, { scope: row.scope, projectId: row.project_id });
        })();
        response.json({ ok: true });
    });

    router.post('/memories/:id/review', (request, response) => {
        const row = memoryById(request.params.id, request.user);
        const input = objectInput(request.body, ['decision']);
        if (!['approve', 'reject'].includes(input.decision)) fail(400, 'INVALID_MEMORY_REVIEW', '请选择通过或拒绝。');
        if (!['candidate', 'conflict'].includes(row.status)) fail(409, 'MEMORY_NOT_PENDING', '这条记忆已不在待审核状态。');
        if (row.project_id) project(request.user, row.project_id, true);
        if (row.scope === 'project_shared') requireProjectAdmin(db, request.user, row.project_id);
        db.transaction(() => {
            if (input.decision === 'approve' && row.conflict_with_id) {
                const previous = db.prepare('SELECT * FROM memories WHERE id=?').get(row.conflict_with_id);
                if (previous && previous.status === 'active') {
                    db.prepare(`UPDATE memories SET status='inactive',version=version+1,embedding=NULL,updated_at=? WHERE id=?`).run(Date.now(), previous.id);
                }
            }
            db.prepare(`UPDATE memories SET status=?,origin='manual',version=version+1,embedding=NULL,
                embedding_model=NULL,embedding_dimension=NULL,updated_at=? WHERE id=?`).run(input.decision === 'approve' ? 'active' : 'rejected', Date.now(), row.id);
            bumpControl(db, scopeKey(row.scope, row.user_id, row.project_id));
            audit(db, request.user, 'memory.' + input.decision, 'memory', row.id, { scope: row.scope, projectId: row.project_id });
        })();
        const updated = db.prepare('SELECT * FROM memories WHERE id=?').get(row.id);
        queueIndex(updated);
        response.json({ memory: publicMemory(updated, request.user) });
    });

    router.post('/memories/:id/reindex', (request, response) => {
        const row = memoryById(request.params.id, request.user);
        if (row.project_id) project(request.user, row.project_id, true);
        if (row.scope === 'project_shared') requireProjectAdmin(db, request.user, row.project_id);
        if (row.status !== 'active') fail(409, 'MEMORY_NOT_ACTIVE', '只有生效中的记忆需要语义索引。');
        const existing = db.prepare('SELECT * FROM memory_index_jobs WHERE memory_id=? AND memory_version=? AND model=?')
            .get(row.id, row.version, embeddingModel);
        if (existing?.state === 'running') fail(409, 'MEMORY_INDEX_RUNNING', '这条记忆正在建立索引。');
        db.transaction(() => {
            db.prepare('UPDATE memories SET embedding=NULL,embedding_model=NULL,embedding_dimension=NULL WHERE id=?').run(row.id);
            if (existing) db.prepare(`UPDATE memory_index_jobs SET state='queued',error_code=NULL,updated_at=? WHERE id=?`).run(Date.now(), existing.id);
            else queueIndex(row);
            audit(db, request.user, 'memory.reindex', 'memory', row.id, { scope: row.scope, projectId: row.project_id });
        })();
        schedule();
        response.json({ memory: publicMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(row.id), request.user) });
    });

    router.get('/memory/jobs', (request, response) => {
        employee(request.user);
        const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : null;
        if (conversationId) {
            const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL').get(conversationId, request.user.id);
            if (!conversation) fail(404, 'CONVERSATION_NOT_FOUND', '对话不存在。');
            if (conversation.project_id) project(request.user, conversation.project_id);
        }
        const jobs = db.prepare(`SELECT jobs.* FROM memory_jobs jobs JOIN conversations conversation ON conversation.id=jobs.conversation_id
            WHERE jobs.user_id=? AND conversation.deleted_at IS NULL AND (? IS NULL OR jobs.conversation_id=?)
            ORDER BY jobs.created_at DESC LIMIT 100`).all(request.user.id, conversationId, conversationId)
            .filter(job => {
                const conversation = db.prepare('SELECT project_id FROM conversations WHERE id=?').get(job.conversation_id);
                return !conversation.project_id || projectRole(db, request.user, conversation.project_id);
            });
        response.json({ jobs: jobs.map(publicJob) });
    });

    router.post('/memory/jobs/:id/retry', (request, response) => {
        employee(request.user);
        const job = db.prepare('SELECT * FROM memory_jobs WHERE id=? AND user_id=?').get(request.params.id, request.user.id);
        if (!job) fail(404, 'MEMORY_JOB_NOT_FOUND', '记忆处理记录不存在。');
        if (!sourceState(job)) fail(409, 'MEMORY_SOURCE_CHANGED', '来源或记忆设置已改变，不能重新提取旧内容。');
        if (!['failed', 'interrupted'].includes(job.state)) fail(409, 'MEMORY_JOB_NOT_RETRYABLE', '此任务无需重试。');
        db.prepare(`UPDATE memory_jobs SET state='queued',error_code=NULL,updated_at=? WHERE id=?`).run(Date.now(), job.id);
        audit(db, request.user, 'memory.retry', 'memory_job', job.id);
        schedule();
        response.json({ job: publicJob(db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(job.id)) });
    });

    function start() {
        if (started) return;
        stopping = false;
        db.prepare(`UPDATE memory_jobs SET state='interrupted',error_code='MEMORY_JOB_INTERRUPTED',updated_at=? WHERE state='running'`).run(Date.now());
        db.prepare(`UPDATE memory_index_jobs SET state='interrupted',error_code='MEMORY_JOB_INTERRUPTED',updated_at=? WHERE state='running'`).run(Date.now());
        started = true;
        for (const row of db.prepare(`SELECT * FROM memories WHERE status='active' AND
            (embedding IS NULL OR embedding_model<>?)`).all(embeddingModel)) queueIndex(row);
        schedule();
    }

    async function stop() {
        stopping = true;
        started = false;
        if (timer) clearTimeout(timer);
        timer = null;
        activeController?.abort();
        await draining;
        queryCache.clear();
    }

    function health() {
        return { ready: true, running: Boolean(draining), fullTextAvailable: search.fullTextAvailable,
            queued: db.prepare(`SELECT COUNT(*) AS count FROM memory_jobs WHERE state='queued'`).get().count,
            failed: db.prepare(`SELECT COUNT(*) AS count FROM memory_jobs WHERE state IN ('failed','interrupted')`).get().count,
            embeddingModel };
    }

    return { router, start, stop, enqueueTurn, retrieve, revalidate, health };
}
