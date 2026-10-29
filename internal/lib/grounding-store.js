export function initializeGroundingSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS source_confirmations (
        id TEXT PRIMARY KEY NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('memory','file')),
        source_id TEXT NOT NULL,
        source_version INTEGER NOT NULL CHECK(source_version>0),
        confirmed_by TEXT NOT NULL REFERENCES users(id),
        confirmed_at INTEGER NOT NULL,
        revoked_by TEXT REFERENCES users(id),
        revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS source_confirmation_current
        ON source_confirmations(source_type,source_id,source_version) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS source_confirmation_lookup ON source_confirmations(source_type,source_id,source_version);
    CREATE TABLE IF NOT EXISTS standard_facts (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('personal','project_private','project_shared')),
        user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id),
        entity TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL DEFAULT '[]', conditions TEXT NOT NULL DEFAULT '', valid_from TEXT, valid_until TEXT,
        source_type TEXT NOT NULL CHECK(source_type IN ('memory','file')),
        source_id TEXT NOT NULL, source_version INTEGER NOT NULL CHECK(source_version>0),
        source_confirmation_id TEXT REFERENCES source_confirmations(id),
        evidence TEXT NOT NULL, evidence_chunk_id TEXT,
        status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed','revoked')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        confirmed_by TEXT REFERENCES users(id), confirmed_at INTEGER,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK((scope='personal' AND project_id IS NULL) OR (scope<>'personal' AND project_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS standard_facts_scope ON standard_facts(scope,user_id,project_id,status);
    CREATE INDEX IF NOT EXISTS standard_facts_source ON standard_facts(source_type,source_id,source_version,status);
    CREATE INDEX IF NOT EXISTS standard_facts_entity ON standard_facts(entity,field,status);
    CREATE TABLE IF NOT EXISTS fact_confirmations (
        id TEXT PRIMARY KEY NOT NULL,
        fact_id TEXT NOT NULL REFERENCES standard_facts(id), fact_version INTEGER NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('memory','file')),
        source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
        source_confirmation_id TEXT NOT NULL REFERENCES source_confirmations(id),
        confirmed_by TEXT NOT NULL REFERENCES users(id), confirmed_at INTEGER NOT NULL,
        canonical_value TEXT NOT NULL,
        revoked_by TEXT REFERENCES users(id), revoked_at INTEGER,
        UNIQUE(fact_id,fact_version)
    );
    CREATE INDEX IF NOT EXISTS fact_confirmation_history ON fact_confirmations(fact_id,confirmed_at);`);
    const columns = new Set(db.prepare('PRAGMA table_info(standard_facts)').all().map(column => column.name));
    for (const [name, definition] of [['conditions', "TEXT NOT NULL DEFAULT ''"], ['valid_from', 'TEXT'], ['valid_until', 'TEXT']]) {
        if (!columns.has(name)) db.exec('ALTER TABLE standard_facts ADD COLUMN ' + name + ' ' + definition);
    }
}
