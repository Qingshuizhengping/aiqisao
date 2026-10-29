import { PARSER_MESSAGES } from './knowledge-parser.js';

export const ERROR_MESSAGES = { ...PARSER_MESSAGES, KNOWLEDGE_SECRET_BLOCKED: '文件含有密码、密钥或验证码，不能加入检索资料库。请移除敏感凭据后重新上传。',
    KNOWLEDGE_ACCESS_CHANGED: '账号或项目权限已改变，处理已停止。恢复权限后可以重试。' };
const METADATA_COLUMNS = ['id', 'scope', 'user_id', 'project_id', 'name', 'extension', 'mime_type', 'size_bytes', 'sha256',
    'text_content', 'status', 'processing_state', 'index_state', 'error_code', 'version', 'chunk_count', 'character_count',
    'created_at', 'updated_at', 'deleted_at'];
export function fileFields(alias = '') {
    const prefix = alias ? alias + '.' : '';
    return METADATA_COLUMNS.map(column => prefix + column).join(',') + ',' + prefix + 'original IS NOT NULL AS has_original';
}

export function schema(db) {
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

