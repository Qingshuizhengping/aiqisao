import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Adds a column only when it is missing, so the schema can grow without a migration
 * framework (the same manual ALTER style this file already used for `users.deleted_at`).
 *
 * @param {import('better-sqlite3').Database} db Open database handle.
 * @param {string} table Table name (trusted constant, never user input).
 * @param {string} column Column name (trusted constant).
 * @param {string} definition SQL column definition, e.g. 'INTEGER NOT NULL DEFAULT 1'.
 * @returns {void}
 */
function addColumnIfMissing(db, table, column, definition) {
    const exists = db.prepare('PRAGMA table_info(' + table + ')').all().some(entry => entry.name === column);
    if (!exists) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
}

export function openDatabase(filename) {
    if (filename !== ':memory:') {
        const directory = path.dirname(path.resolve(filename));
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(directory).isSymbolicLink() || fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Invalid private database path');
        fs.chmodSync(directory, 0o700);
    }
    const db = new Database(filename);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            system_role TEXT NOT NULL DEFAULT 'member' CHECK(system_role IN ('admin','member')),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
            auto_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_memory_enabled IN (0,1)),
            search_enabled INTEGER NOT NULL DEFAULT 1 CHECK(search_enabled IN (0,1)),
            mfa_secret TEXT,
            mfa_last_step INTEGER,
            deleted_at INTEGER CHECK(deleted_at IS NULL OR active=0),
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id),
            csrf_token TEXT NOT NULL,
            pending_mfa_secret TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            instructions TEXT NOT NULL DEFAULT '',
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
            created_by TEXT NOT NULL REFERENCES users(id),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_members (
            project_id TEXT NOT NULL REFERENCES projects(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            role TEXT NOT NULL CHECK(role IN ('admin','member')),
            created_at INTEGER NOT NULL,
            PRIMARY KEY(project_id,user_id)
        );
        CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id,project_id);
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id),
            project_id TEXT REFERENCES projects(id),
            title TEXT NOT NULL DEFAULT '新对话',
            memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK(memory_enabled IN (0,1)),
            summary TEXT NOT NULL DEFAULT '',
            summary_message_id TEXT,
            deleted_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id,project_id,updated_at);
        CREATE INDEX IF NOT EXISTS conversations_project ON conversations(project_id,updated_at);
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            role TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'complete' CHECK(status IN ('complete','generating','stopped','failed','interrupted')),
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at,id);
        CREATE TABLE IF NOT EXISTS chat_runs (
            id TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            request_id TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            user_message_id TEXT NOT NULL REFERENCES messages(id),
            assistant_message_id TEXT NOT NULL REFERENCES messages(id),
            state TEXT NOT NULL CHECK(state IN ('queued','running','completed','stopped','failed','interrupted')),
            error_code TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id,request_id)
        );
        CREATE INDEX IF NOT EXISTS chat_runs_conversation ON chat_runs(conversation_id,state);
        CREATE INDEX IF NOT EXISTS chat_runs_user ON chat_runs(user_id,state);
        CREATE TABLE IF NOT EXISTS audit_records (
            id TEXT PRIMARY KEY NOT NULL,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_created ON audit_records(created_at);
        CREATE INDEX IF NOT EXISTS audit_actor ON audit_records(actor_id,created_at);
    `);
    // Column migrations (existing databases keep their data). R1-06 adds the per-member
    // search preference; the default keeps current behaviour (search allowed).
    addColumnIfMissing(db, 'users', 'deleted_at', 'INTEGER CHECK(deleted_at IS NULL OR active=0)');
    addColumnIfMissing(db, 'users', 'search_enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK(search_enabled IN (0,1))');
    db.exec('CREATE INDEX IF NOT EXISTS users_status ON users(deleted_at,active,system_role)');
    if (filename !== ':memory:') {
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(filename + suffix)) fs.chmodSync(filename + suffix, 0o600);
        }
    }
    return db;
}
