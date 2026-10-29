import { randomUUID } from 'node:crypto';
import { audit, projectRole, requireProjectAdmin, requireReadyEmployee, requireProjectContext } from './access.js';
import { fail } from './errors.js';
import { controlRevision, normalized, sensitive } from './memory-store.js';
import { initializeGroundingSchema } from './grounding-store.js';
import { createGroundingRouter } from './grounding-records.js';
import { applicabilityInput } from './grounding-values.js';

const SCOPES = new Set(['personal', 'project_private', 'project_shared']);
const TYPES = new Set(['memory', 'file']);
function objectInput(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail(400, 'INVALID_GROUNDING_INPUT', '核验资料参数无效。');
    return value;
}
function text(value, maximum, optional = false) {
    if (typeof value !== 'string' || value.trim().length > maximum || (!optional && !value.trim()) || /\u0000/.test(value)) fail(400, 'INVALID_GROUNDING_INPUT', '核验资料文字无效或过长。');
    return value.trim();
}
function expectedVersion(input, current) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'INVALID_GROUNDING_INPUT', '请提供当前资料版本。');
    if (input.version !== current) fail(409, 'GROUNDING_VERSION_CHANGED', '资料版本已更新，请刷新后重新核对。');
}
function tokenPresent(evidence, value) {
    const body = evidence.normalize('NFKC');
    const word = value.normalize('NFKC');
    let offset = body.indexOf(word);
    while (offset !== -1) {
        const before = body[offset - 1] || '', after = body[offset + word.length] || '';
        const prefix = body.slice(Math.max(0, offset - 12), offset);
        if (!/\d/.test(word)) {
            const joinedWord = /[A-Za-z]/.test(word[0] || '') && /[A-Za-z]/.test(before)
                || /[A-Za-z]/.test(word.at(-1) || '') && /[A-Za-z]/.test(after);
            const negated = /(?:不|未|无|非|禁止|不得|不可|not\s+|never\s+)$/i.test(prefix);
            if (!joinedWord && !negated) return true;
            offset = body.indexOf(word, offset + 1);
            continue;
        }
        const numberBefore = /\d/.test(before) || /[+-]/.test(before) || before === '.' && /\d/.test(body[offset - 2] || '');
        const numberAfter = /\d/.test(after) || after === '.' && /\d/.test(body[offset + word.length + 1] || '');
        if (!numberBefore && !numberAfter) return true;
        offset = body.indexOf(word, offset + 1);
    }
    return false;
}

export function createGroundingLibrary({ db, provider }) {
    initializeGroundingSchema(db);
    const suggestions = new Map();
    const ready = user => requireReadyEmployee(db, user).user;
    function scopeInput(query, user) {
        ready(user);
        const scope = query.scope ?? 'personal';
        const projectId = query.projectId === undefined || query.projectId === '' ? null : query.projectId;
        if (!SCOPES.has(scope) || projectId !== null && (typeof projectId !== 'string' || projectId.length > 200)
            || scope === 'personal' && projectId || scope !== 'personal' && !projectId) fail(400, 'INVALID_GROUNDING_SCOPE', '资料范围与项目不匹配。');
        if (projectId) requireProjectContext(db, user, projectId);
        return { scope, projectId };
    }
    function rawSource(type, id) {
        if (!TYPES.has(type) || typeof id !== 'string' || !id || id.length > 200) fail(400, 'INVALID_GROUNDING_SOURCE', '来源标识无效。');
        return db.prepare(type === 'memory' ? 'SELECT * FROM memories WHERE id=?' : 'SELECT * FROM knowledge_files WHERE id=?').get(id);
    }
    function visible(row, user) {
        if (!row || row.status === 'deleted' || row.deleted_at) return false;
        if (row.scope === 'personal') return row.user_id === user.id;
        const role = projectRole(db, user, row.project_id);
        return Boolean(role && (row.scope === 'project_private' ? row.user_id === user.id
            : row.status === 'active' || role === 'admin' || row.user_id === user.id));
    }
    function usable(type, row) {
        return Boolean(row?.status === 'active' && !row.deleted_at && (type === 'memory' || row.processing_state === 'ready'));
    }
    function canManage(row, user) {
        if (row.project_id && db.prepare('SELECT archived FROM projects WHERE id=?').get(row.project_id)?.archived) return false;
        return row.scope === 'project_shared' ? projectRole(db, user, row.project_id) === 'admin' : row.user_id === user.id;
    }
    function assertManage(row, user) {
        ready(user);
        if (row.project_id) requireProjectContext(db, user, row.project_id, { write: true });
        if (row.scope === 'project_shared') requireProjectAdmin(db, user, row.project_id);
        else if (row.user_id !== user.id) fail(403, 'GROUNDING_WRITE_DENIED', '只能确认自己有权维护的资料。');
    }
    function confirmation(type, row) {
        return db.prepare('SELECT * FROM source_confirmations WHERE source_type=? AND source_id=? AND source_version=? AND revoked_at IS NULL')
            .get(type, row.id, row.version);
    }
    function sourceView(type, row, user, preview = false) {
        const confirm = usable(type, row) ? confirmation(type, row) : null;
        const previous = db.prepare('SELECT 1 FROM source_confirmations WHERE source_type=? AND source_id=? LIMIT 1').get(type, row.id);
        const content = type === 'memory' ? row.content : row.text_content;
        return { id: type + ':' + row.id, type, sourceType: type, sourceId: row.id, version: row.version,
            title: type === 'memory' ? row.content.slice(0, 48) || '记忆条目' : row.name,
            content: preview ? content.slice(0, 1200) : content,
            scope: row.scope, userId: row.user_id, projectId: row.project_id, status: row.status,
            confirmed: Boolean(confirm), confirmationId: confirm?.id || null,
            confirmation: confirm ? { id: confirm.id, version: confirm.source_version, confirmedBy: confirm.confirmed_by, confirmedAt: confirm.confirmed_at } : null,
            canConfirm: Boolean(usable(type, row) && !confirm && canManage(row, user)),
            canRevoke: Boolean(confirm && canManage(row, user)), needsReconfirmation: Boolean(previous && !confirm),
            createdAt: row.created_at, updatedAt: row.updated_at };
    }
    function source({ user, type, id, version }) {
        user = ready(user);
        const row = rawSource(type, id);
        if (!visible(row, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源不存在或无权访问。');
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) fail(400, 'INVALID_GROUNDING_INPUT', '来源版本无效。');
        if (version !== undefined && version !== row.version) fail(409, 'GROUNDING_VERSION_CHANGED', '来源版本已更新。');
        return sourceView(type, row, user);
    }
    function confirmSource(user, type, id, input) {
        user = ready(user); objectInput(input, ['version']);
        const row = rawSource(type, id);
        if (!visible(row, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源不存在或无权访问。');
        assertManage(row, user); expectedVersion(input, row.version);
        if (!usable(type, row)) fail(409, 'GROUNDING_SOURCE_NOT_READY', '请先等待来源解析完成，并完成共享或冲突审核。');
        if (sensitive(type === 'memory' ? row.content : row.text_content)) fail(422, 'GROUNDING_SECRET_BLOCKED', '含敏感凭据的内容不能确认用于回答。');
        if (!confirmation(type, row)) db.transaction(() => {
            db.prepare('INSERT INTO source_confirmations(id,source_type,source_id,source_version,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?)')
                .run(randomUUID(), type, id, row.version, user.id, Date.now());
            audit(db, user, 'grounding.source_confirm', type, id, { version: row.version, scope: row.scope, projectId: row.project_id });
        })();
        return sourceView(type, row, user);
    }
    function revokeSource(user, type, id, input) {
        user = ready(user); objectInput(input, ['version']);
        const row = rawSource(type, id);
        if (!visible(row, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源不存在或无权访问。');
        assertManage(row, user); expectedVersion(input, row.version);
        db.transaction(() => {
            db.prepare('UPDATE source_confirmations SET revoked_by=?,revoked_at=? WHERE source_type=? AND source_id=? AND source_version=? AND revoked_at IS NULL')
                .run(user.id, Date.now(), type, id, row.version);
            audit(db, user, 'grounding.source_revoke', type, id, { version: row.version, scope: row.scope, projectId: row.project_id });
        })();
        return sourceView(type, row, user);
    }
    function factSource(row, user) {
        const original = rawSource(row.source_type, row.source_id);
        if (!visible(original, user) || original.scope !== row.scope || original.user_id !== row.user_id || original.project_id !== row.project_id) return null;
        return original;
    }
    function activeFact(row, original) {
        const confirm = original && usable(row.source_type, original) && confirmation(row.source_type, original);
        return Boolean(row.status === 'confirmed' && original?.version === row.source_version && confirm && row.source_confirmation_id === confirm.id);
    }
    function factView(row, user) {
        const original = factSource(row, user);
        const confirmed = Boolean(original && activeFact(row, original));
        const manage = Boolean(original && canManage(original, user));
        const sourceConfirmed = Boolean(original && usable(row.source_type, original) && original.version === row.source_version && confirmation(row.source_type, original));
        return { id: row.id, version: row.version, entity: row.entity, field: row.field, value: row.value, unit: row.unit,
            conditions: row.conditions, validFrom: row.valid_from, validUntil: row.valid_until,
            aliases: JSON.parse(row.aliases), evidence: row.evidence, evidenceChunkId: row.evidence_chunk_id,
            scope: row.scope, userId: row.user_id, projectId: row.project_id, sourceType: row.source_type, sourceId: row.source_id,
            sourceVersion: row.source_version, sourceConfirmationId: row.source_confirmation_id,
            status: row.status, confirmed, confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at,
            canEdit: manage, canConfirm: Boolean(manage && sourceConfirmed && !confirmed && row.status !== 'revoked'),
            canRevoke: Boolean(manage && row.status !== 'revoked'), needsReconfirmation: Boolean(row.status === 'confirmed' && !confirmed),
            createdAt: row.created_at, updatedAt: row.updated_at };
    }
    function getFact(user, id) {
        user = ready(user);
        const row = db.prepare('SELECT * FROM standard_facts WHERE id=?').get(id);
        if (!row || !factSource(row, user)) fail(404, 'GROUNDING_FACT_NOT_FOUND', '标准事实不存在或无权访问。');
        return row;
    }
    function factInput(input, original, sourceType) {
        const entity = text(input.entity, 160), field = text(input.field, 80), value = text(input.value, 300), unit = text(input.unit ?? '', 40, true);
        const evidence = text(input.evidence, 3000);
        const aliases = input.aliases ?? [];
        if (!Array.isArray(aliases) || aliases.length > 20) fail(400, 'INVALID_GROUNDING_INPUT', '别名参数无效。');
        const names = [...new Set(aliases.map(value => text(value, 160)))];
        const content = sourceType === 'memory' ? original.content : original.text_content;
        if (!content.includes(evidence) || !tokenPresent(evidence, value) || unit && !evidence.includes(unit)) fail(422, 'GROUNDING_EVIDENCE_MISMATCH', '证据必须为当前来源原文，并包含完整的数值及单位。');
        if (![entity, ...names].some(name => normalized(evidence).includes(normalized(name)))) fail(422, 'GROUNDING_ENTITY_MISMATCH', '本条证据未包含该对象或其别名，请核对原文与对象对应关系。');
        const chunkId = input.evidenceChunkId ?? null;
        if (chunkId !== null && (sourceType !== 'file' || typeof chunkId !== 'string'
            || !db.prepare('SELECT 1 FROM knowledge_chunks WHERE id=? AND file_id=? AND file_version=? AND instr(content,?)>0').get(chunkId, original.id, original.version, evidence))) {
            fail(422, 'GROUNDING_EVIDENCE_MISMATCH', '证据片段不属于当前文件版本。');
        }
        if (sensitive([entity, field, value, unit, evidence, ...names].join('\n'))) fail(422, 'GROUNDING_SECRET_BLOCKED', '含敏感凭据的内容不能加入标准事实。');
        return { entity, field, value, unit, evidence, aliases: names, chunkId, ...applicabilityInput(input, evidence) };
    }
    function createFact(user, input) {
        user = ready(user);
        objectInput(input, ['sourceType','sourceId','sourceVersion','entity','field','value','unit','aliases','evidence','evidenceChunkId','conditions','validFrom','validUntil']);
        const original = rawSource(input.sourceType, input.sourceId);
        if (!visible(original, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源不存在或无权访问。');
        assertManage(original, user); expectedVersion({ version: input.sourceVersion }, original.version);
        if (!usable(input.sourceType, original)) fail(409, 'GROUNDING_SOURCE_NOT_READY', '来源尚未生效或解析完成。');
        const values = factInput(input, original, input.sourceType), id = randomUUID(), now = Date.now();
        db.transaction(() => {
            db.prepare(`INSERT INTO standard_facts(id,scope,user_id,project_id,entity,field,value,unit,aliases,source_type,source_id,source_version,
                evidence,evidence_chunk_id,conditions,valid_from,valid_until,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, original.scope, original.user_id, original.project_id, values.entity, values.field, values.value, values.unit,
                    JSON.stringify(values.aliases), input.sourceType, original.id, original.version, values.evidence, values.chunkId,
                    values.conditions, values.validFrom, values.validUntil, user.id, now, now);
            audit(db, user, 'grounding.fact_create', 'standard_fact', id, { sourceType: input.sourceType, sourceId: original.id, scope: original.scope, projectId: original.project_id });
        })();
        return factView(getFact(user, id), user);
    }
    function updateFact(user, id, input) {
        user = ready(user);
        objectInput(input, ['version','entity','field','value','unit','aliases','evidence','evidenceChunkId','conditions','validFrom','validUntil']);
        const row = getFact(user, id), original = factSource(row, user);
        assertManage(original, user); expectedVersion(input, row.version);
        if (!usable(row.source_type, original)) fail(409, 'GROUNDING_SOURCE_NOT_READY', '来源尚未生效或解析完成。');
        const values = factInput({ ...factView(row, user), ...input }, original, row.source_type);
        db.transaction(() => {
            db.prepare('UPDATE fact_confirmations SET revoked_by=?,revoked_at=? WHERE fact_id=? AND revoked_at IS NULL').run(user.id, Date.now(), id);
            db.prepare(`UPDATE standard_facts SET entity=?,field=?,value=?,unit=?,aliases=?,evidence=?,evidence_chunk_id=?,source_version=?,conditions=?,valid_from=?,valid_until=?,
                status='candidate',source_confirmation_id=NULL,confirmed_by=NULL,confirmed_at=NULL,version=version+1,updated_at=? WHERE id=?`)
                .run(values.entity, values.field, values.value, values.unit, JSON.stringify(values.aliases), values.evidence, values.chunkId, original.version,
                    values.conditions, values.validFrom, values.validUntil, Date.now(), id);
            audit(db, user, 'grounding.fact_update', 'standard_fact', id, { version: row.version + 1 });
        })();
        return factView(getFact(user, id), user);
    }
    function confirmFact(user, id, input) {
        user = ready(user); objectInput(input, ['version']);
        const row = getFact(user, id), original = factSource(row, user);
        assertManage(original, user); expectedVersion(input, row.version);
        if (row.status === 'revoked') fail(409, 'GROUNDING_FACT_REVOKED', '请先编辑已撤销的事实，再重新核对确认。');
        const confirm = usable(row.source_type, original) && original.version === row.source_version && confirmation(row.source_type, original);
        if (!confirm) fail(409, 'GROUNDING_SOURCE_UNCONFIRMED', '请先确认当前版本的来源资料。');
        factInput(factView(row, user), original, row.source_type);
        applicabilityInput(factView(row, user), row.evidence, true);
        if (!activeFact(row, original)) db.transaction(() => {
            const now = Date.now();
            db.prepare('UPDATE fact_confirmations SET revoked_by=?,revoked_at=? WHERE fact_id=? AND revoked_at IS NULL').run(user.id, now, id);
            db.prepare(`UPDATE standard_facts SET status='confirmed',source_confirmation_id=?,confirmed_by=?,confirmed_at=?,version=version+1,updated_at=? WHERE id=?`)
                .run(confirm.id, user.id, now, now, id);
            db.prepare(`INSERT INTO fact_confirmations(id,fact_id,fact_version,source_type,source_id,source_version,
                source_confirmation_id,confirmed_by,confirmed_at,canonical_value) VALUES(?,?,?,?,?,?,?,?,?,?)`)
                .run(randomUUID(), id, row.version + 1, row.source_type, row.source_id, row.source_version, confirm.id, user.id, now,
                    JSON.stringify({ entity: row.entity, field: row.field, value: row.value, unit: row.unit, aliases: JSON.parse(row.aliases),
                        conditions: row.conditions, validFrom: row.valid_from, validUntil: row.valid_until }));
            audit(db, user, 'grounding.fact_confirm', 'standard_fact', id, { version: row.version + 1, sourceVersion: row.source_version });
        })();
        return factView(getFact(user, id), user);
    }
    function revokeFact(user, id, input, optionalVersion = false) {
        user = ready(user); objectInput(input, optionalVersion ? ['version'] : ['version']);
        const row = getFact(user, id), original = factSource(row, user);
        assertManage(original, user);
        if (!optionalVersion || input.version !== undefined) expectedVersion(input, row.version);
        if (row.status !== 'revoked') db.transaction(() => {
            db.prepare('UPDATE fact_confirmations SET revoked_by=?,revoked_at=? WHERE fact_id=? AND revoked_at IS NULL').run(user.id, Date.now(), id);
            db.prepare("UPDATE standard_facts SET status='revoked',version=version+1,updated_at=? WHERE id=?").run(Date.now(), id);
            audit(db, user, 'grounding.fact_revoke', 'standard_fact', id, { version: row.version + 1 });
        })();
        return factView(getFact(user, id), user);
    }
    async function suggestFacts(user, type, id, input, { sessionId, signal } = {}) {
        user = ready(user); objectInput(input, ['version']);
        let original = rawSource(type, id);
        if (!visible(original, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源不存在或无权访问。');
        assertManage(original, user); expectedVersion(input, original.version);
        if (!usable(type, original)) fail(409, 'GROUNDING_SOURCE_NOT_READY', '请先等待来源生效或解析完成。');
        const content = type === 'memory' ? original.content : original.text_content;
        if (sensitive(content)) fail(422, 'GROUNDING_SECRET_BLOCKED', '含敏感凭据的资料不能交给模型整理。');
        if (!provider?.proposeFacts) fail(503, 'GROUNDING_SUGGEST_UNAVAILABLE', '事实候选整理暂不可用。');
        function validSession() {
            if (!sessionId || !db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(sessionId, user.id, Date.now())) {
                fail(401, 'AUTH_REQUIRED', '登录状态已改变，请重新登录。');
            }
        }
        function stamp(row) {
            return JSON.stringify([row.version, row.status, row.scope, row.user_id, row.project_id,
                confirmation(type, row)?.id || null, controlRevision(db, 'user:' + user.id),
                row.project_id ? controlRevision(db, 'membership:' + user.id + ':' + row.project_id) : 0,
                row.project_id ? controlRevision(db, 'project:' + row.project_id) : 0]);
        }
        validSession();
        const now = Date.now();
        for (const [key, times] of suggestions) if (!times.some(time => time > now - 60000)) suggestions.delete(key);
        const times = (suggestions.get(user.id) || []).filter(time => time > now - 60000);
        if (times.length >= 3 || suggestions.size >= 2048 && !suggestions.has(user.id)) fail(429, 'GROUNDING_SUGGEST_RATE_LIMIT', '整理操作过于频繁，请稍后重试。');
        suggestions.set(user.id, [...times, now]);
        const started = stamp(original);
        let result;
        try {
            result = await provider.proposeFacts({ source: { type, id, version: original.version,
                title: type === 'memory' ? original.content.slice(0, 48) || '记忆条目' : original.name, content: content.slice(0, 24000), truncated: content.length > 24000 } }, { signal });
        } catch (error) {
            if (signal?.aborted) throw error;
            fail(502, 'GROUNDING_SUGGEST_UNAVAILABLE', '事实候选整理未完成，请稍后重试。');
        }
        signal?.throwIfAborted(); validSession(); user = ready(user);
        original = rawSource(type, id);
        if (!visible(original, user)) fail(404, 'GROUNDING_SOURCE_NOT_FOUND', '来源已失效或无权访问。');
        assertManage(original, user);
        if (!usable(type, original) || stamp(original) !== started) fail(409, 'GROUNDING_VERSION_CHANGED', '资料或权限已更新，未保存旧的整理结果。');
        objectInput(result, ['facts']);
        if (!Array.isArray(result.facts) || result.facts.length > 12) fail(502, 'GROUNDING_SUGGEST_INVALID', '候选整理返回格式无效。');
        const facts = db.transaction(() => result.facts.map(candidate => {
            objectInput(candidate, ['entity','field','value','unit','aliases','evidence','evidenceChunkId','conditions','validFrom','validUntil']);
            return createFact(user, { ...candidate, sourceType: type, sourceId: id, sourceVersion: original.version });
        }))();
        audit(db, user, 'grounding.fact_suggest', type, id, { count: facts.length, version: original.version, partial: content.length > 24000 });
        return { facts, partial: content.length > 24000 };
    }
    function scopedRows(type, scope, projectId, userId) {
        const table = type === 'memory' ? 'memories' : 'knowledge_files';
        return db.prepare(`SELECT * FROM ${table} WHERE scope=? AND project_id IS ? AND (scope='project_shared' OR user_id=?) AND status<>'deleted' ORDER BY updated_at DESC,id`)
            .all(scope, projectId, userId);
    }
    function page(query) {
        const limit = query.limit === undefined ? 100 : Number(query.limit), offset = query.offset === undefined ? 0 : Number(query.offset);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail(400, 'INVALID_PAGINATION', '分页参数无效。');
        if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 200)) fail(400, 'INVALID_GROUNDING_INPUT', '搜索文字无效或过长。');
        return { limit, offset, q: normalized(query.q || '') };
    }
    function listSources(user, query) {
        user = ready(user); const { scope, projectId } = scopeInput(query, user), { limit, offset, q } = page(query);
        const sources = ['memory','file'].flatMap(type => scopedRows(type, scope, projectId, user.id)
            .filter(row => visible(row, user) && (!q || normalized((type === 'memory' ? row.content : row.name + '\n' + row.text_content)).includes(q)))
            .map(row => sourceView(type, row, user, true)))
            .sort((a,b) => b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
        return { sources: sources.slice(offset, offset + limit), hasMore: sources.length > offset + limit, limit, offset };
    }
    function listFacts(user, query) {
        user = ready(user); const { scope, projectId } = scopeInput(query, user), { limit, offset, q } = page(query);
        const facts = db.prepare("SELECT * FROM standard_facts WHERE scope=? AND project_id IS ? AND (scope='project_shared' OR user_id=?) ORDER BY updated_at DESC,id")
            .all(scope, projectId, user.id).filter(row => factSource(row, user)).map(row => factView(row, user))
            .filter(row => !q || normalized([row.entity,row.field,row.value,...row.aliases].join(' ')).includes(q));
        return { facts: facts.slice(offset, offset + limit), hasMore: facts.length > offset + limit, limit, offset };
    }
    function catalog({ user, projectId = null }) {
        user = ready(user); if (projectId) requireProjectContext(db, user, projectId);
        const scopes = [{ scope:'personal', projectId:null }, ...(projectId ? [{ scope:'project_private', projectId }, { scope:'project_shared', projectId }] : [])];
        const sources = scopes.flatMap(current => ['memory','file'].flatMap(type => scopedRows(type, current.scope, current.projectId, user.id)
            .filter(row => usable(type, row) && visible(row, user) && confirmation(type, row))
            .map(row => sourceView(type, row, user))));
        const available = new Set(sources.map(row => row.id));
        const facts = db.prepare("SELECT * FROM standard_facts WHERE status='confirmed'").all()
            .filter(row => available.has(row.source_type + ':' + row.source_id) && activeFact(row, factSource(row, user))).map(row => factView(row, user));
        return { sources, facts };
    }
    function revalidate({ user, projectId = null, evidence = [], facts = [] }) {
        user = ready(user); if (projectId) requireProjectContext(db, user, projectId);
        const inScope = row => row.scope === 'personal' ? row.user_id === user.id && row.project_id === null : row.project_id === projectId;
        const currentEvidence = evidence.flatMap(entry => {
            try {
                const original = rawSource(entry.sourceType, entry.sourceId);
                if (!visible(original, user) || !usable(entry.sourceType, original) || !inScope(original) || entry.version !== original.version) return [];
                const confirm = confirmation(entry.sourceType, original);
                if (!confirm || entry.confirmationId && entry.confirmationId !== confirm.id) return [];
                const common = { sourceType:entry.sourceType, sourceId:original.id, version:original.version,
                    scope:original.scope, userId:original.user_id, projectId:original.project_id, title:entry.sourceType === 'memory' ? original.content.slice(0, 48) || '记忆条目' : original.name, confirmationId:confirm.id };
                if (entry.sourceType === 'memory') return entry.id === 'memory:' + original.id ? [{ ...common, id:entry.id, content:original.content }] : [];
                const chunk = typeof entry.chunkId === 'string' && db.prepare('SELECT * FROM knowledge_chunks WHERE id=? AND file_id=? AND file_version=?').get(entry.chunkId, original.id, original.version);
                return chunk && entry.id === 'file:' + chunk.id ? [{ ...common, id:entry.id, content:chunk.content, chunkId:chunk.id, chunkIndex:chunk.chunk_index }] : [];
            } catch { return []; }
        });
        const currentFacts = facts.flatMap(entry => {
            const row = typeof entry.id === 'string' && db.prepare('SELECT * FROM standard_facts WHERE id=?').get(entry.id);
            const original = row && factSource(row, user);
            return row && row.version === entry.version && inScope(row) && original && activeFact(row, original) ? [factView(row, user)] : [];
        });
        return { evidence:currentEvidence, facts:currentFacts };
    }
    const api = { source, confirmSource, revokeSource, getFact, factView, createFact, updateFact, confirmFact, revokeFact, suggestFacts, listSources, listFacts };
    const router = createGroundingRouter(api);
    return { router, catalog, revalidate, source };
}
