import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.js';

export const MEMORY_SCOPES = ['personal', 'project_private', 'project_shared'];
export const MAX_MEMORY_CONTENT = 1200;

export function fingerprint(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

export function normalized(value) {
    return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function sensitive(value) {
    return /(?:sk-[a-z\d_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?key|secret[_ -]?key|password|密码|口令|密钥|验证码)\s*(?:[:：=]|是|为)\s*\S{4,}|\bBearer\s+[a-z\d._~+/-]{16,})/i.test(String(value));
}

export function contentValue(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_MEMORY_CONTENT || /\u0000/.test(value)) {
        fail(400, 'INVALID_MEMORY_CONTENT', '记忆内容需为 1–1200 字的文字。');
    }
    if (sensitive(value)) fail(400, 'MEMORY_SECRET_BLOCKED', '密码、密钥和验证码不能保存到记忆库。');
    return value.trim();
}

export function scopeKey(scope, userId, projectId) {
    return scope === 'personal' ? 'personal:' + userId : scope === 'project_private'
        ? 'project_private:' + userId + ':' + projectId : 'project_shared:' + projectId;
}

export function controlRevision(db, key) {
    return db.prepare('SELECT revision FROM memory_controls WHERE scope_id=?').get(key)?.revision || 0;
}

export function bumpControl(db, key) {
    db.prepare('INSERT INTO memory_controls(scope_id,revision) VALUES(?,1) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1').run(key);
}

export function vectorBuffer(vector) {
    if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Invalid embedding response');
    }
    const length = Math.hypot(...vector);
    if (!Number.isFinite(length) || length <= 0) throw new Error('Invalid embedding norm');
    const result = Buffer.alloc(vector.length * 4);
    vector.forEach((value, index) => result.writeFloatLE(value / length, index * 4));
    return result;
}

export function readVector(buffer, dimension) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== dimension * 4 || dimension < 1 || dimension > 8192) return null;
    const values = [];
    for (let index = 0; index < dimension; index++) {
        const value = buffer.readFloatLE(index * 4);
        if (!Number.isFinite(value)) return null;
        values.push(value);
    }
    return values;
}

export function initializeMemorySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_controls (
            scope_id TEXT PRIMARY KEY NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY NOT NULL,
            scope TEXT NOT NULL CHECK(scope IN ('personal','project_private','project_shared')),
            user_id TEXT NOT NULL REFERENCES users(id),
            project_id TEXT REFERENCES projects(id),
            content TEXT NOT NULL,
            key TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','candidate','inactive','rejected','deleted','conflict')),
            origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')),
            source_conversation_id TEXT REFERENCES conversations(id),
            source_message_id TEXT REFERENCES messages(id),
            source_evidence TEXT NOT NULL DEFAULT '',
            conflict_with_id TEXT REFERENCES memories(id),
            version INTEGER NOT NULL DEFAULT 1,
            embedding BLOB,
            embedding_model TEXT,
            embedding_dimension INTEGER,
            deleted_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK((scope='personal' AND project_id IS NULL) OR (scope<>'personal' AND project_id IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS memories_owner_scope ON memories(user_id,scope,project_id,status);
        CREATE INDEX IF NOT EXISTS memories_project_scope ON memories(project_id,scope,status);
        CREATE INDEX IF NOT EXISTS memories_deduplication ON memories(scope,project_id,user_id,key,status);
        CREATE INDEX IF NOT EXISTS memories_source ON memories(source_conversation_id,source_message_id);
        CREATE TABLE IF NOT EXISTS memory_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id),
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            user_message_id TEXT NOT NULL REFERENCES messages(id),
            assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
            state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','skipped','interrupted')),
            source_hash TEXT NOT NULL,
            controls TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            result_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_jobs_queue ON memory_jobs(state,created_at);
        CREATE TABLE IF NOT EXISTS memory_index_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            memory_id TEXT NOT NULL REFERENCES memories(id),
            memory_version INTEGER NOT NULL,
            model TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','skipped','interrupted')),
            attempts INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(memory_id,memory_version,model)
        );
        CREATE INDEX IF NOT EXISTS memory_index_queue ON memory_index_jobs(state,created_at);
        CREATE TRIGGER IF NOT EXISTS memory_user_controls AFTER UPDATE OF auto_memory_enabled,active ON users
        WHEN NEW.auto_memory_enabled<>OLD.auto_memory_enabled OR NEW.active<>OLD.active
        BEGIN
            INSERT INTO memory_controls(scope_id,revision) VALUES('user:'||NEW.id,1)
            ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_conversation_controls AFTER UPDATE OF memory_enabled,deleted_at ON conversations
        WHEN NEW.memory_enabled<>OLD.memory_enabled OR NEW.deleted_at IS NOT OLD.deleted_at
        BEGIN
            INSERT INTO memory_controls(scope_id,revision) VALUES('conversation:'||NEW.id,1)
            ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_membership_removed AFTER DELETE ON project_members
        BEGIN
            INSERT INTO memory_controls(scope_id,revision) VALUES('membership:'||OLD.user_id||':'||OLD.project_id,1)
            ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_membership_role_changed AFTER UPDATE OF role ON project_members
        WHEN NEW.role<>OLD.role
        BEGIN
            INSERT INTO memory_controls(scope_id,revision) VALUES('membership:'||NEW.user_id||':'||NEW.project_id,1)
            ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_project_archived AFTER UPDATE OF archived ON projects
        WHEN NEW.archived<>OLD.archived
        BEGIN
            INSERT INTO memory_controls(scope_id,revision) VALUES('project:'||NEW.id,1)
            ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
        END;
    `);
    if (!db.prepare('PRAGMA table_info(memories)').all().some(column => column.name === 'source_evidence')) {
        db.exec("ALTER TABLE memories ADD COLUMN source_evidence TEXT NOT NULL DEFAULT ''");
    }
    let fullTextAvailable = true;
    try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED,content,tokenize='trigram')`);
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memories WHEN NEW.status='active'
            BEGIN INSERT INTO memory_fts(memory_id,content) VALUES(NEW.id,NEW.content); END;
            CREATE TRIGGER IF NOT EXISTS memory_search_update AFTER UPDATE OF content,status ON memories
            BEGIN
                DELETE FROM memory_fts WHERE memory_id=OLD.id;
                INSERT INTO memory_fts(memory_id,content) SELECT NEW.id,NEW.content WHERE NEW.status='active';
            END;
            CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memories
            BEGIN DELETE FROM memory_fts WHERE memory_id=OLD.id; END;
        `);
        db.exec(`INSERT INTO memory_fts(memory_id,content) SELECT id,content FROM memories WHERE status='active'
            AND NOT EXISTS (SELECT 1 FROM memory_fts WHERE memory_id=memories.id)`);
    } catch {
        fullTextAvailable = false;
    }
    return { fullTextAvailable };
}

export function insertMemory(db, { userId, projectId = null, scope, content, status, origin = 'manual', key,
    sourceConversationId = null, sourceMessageId = null, sourceEvidence = '', conflictWithId = null, now = Date.now() }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO memories(id,scope,user_id,project_id,content,key,content_hash,status,origin,
        source_conversation_id,source_message_id,source_evidence,conflict_with_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, userId, projectId, content,
        fingerprint(key || normalized(content)), fingerprint(normalized(content)), status, origin,
        sourceConversationId, sourceMessageId, sourceEvidence, conflictWithId, now, now);
    return db.prepare('SELECT * FROM memories WHERE id=?').get(id);
}
