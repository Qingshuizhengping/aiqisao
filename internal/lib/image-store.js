/**
 * @file `image_jobs` persistence (requirement R2-02/03).
 *
 * The table is created lazily by this module (same pattern as `grounding-store.js`) so the
 * core schema in `database.js` stays untouched. Async job state lives in SQLite — not in
 * memory — which is what makes "close the panel / reload / restart the process and still
 * find your history" work.
 */

import { randomUUID } from 'node:crypto';

/**
 * Creates the `image_jobs` table and its indexes when missing.
 *
 * @param {import('better-sqlite3').Database} db Open database handle.
 * @returns {void}
 */
export function initializeImageSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS image_jobs (
        id             TEXT PRIMARY KEY NOT NULL,
        user_id        TEXT NOT NULL REFERENCES users(id),
        request_id     TEXT NOT NULL,
        input_hash     TEXT NOT NULL,
        prompt         TEXT NOT NULL,
        size_key       TEXT NOT NULL DEFAULT '1:1'
                       CHECK(size_key IN ('1:1','3:4','4:3','9:16','16:9','auto')),
        state          TEXT NOT NULL
                       CHECK(state IN ('queued','running','succeeded','failed')),
        error_code     TEXT,
        error_message  TEXT,
        file_name      TEXT,
        mime_type      TEXT,
        byte_size      INTEGER CHECK(byte_size IS NULL OR byte_size BETWEEN 1 AND 20971520),
        width          INTEGER CHECK(width  IS NULL OR width  BETWEEN 1 AND 4096),
        height         INTEGER CHECK(height IS NULL OR height BETWEEN 1 AND 4096),
        upstream_ms    INTEGER,
        reference_name TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        started_at     INTEGER,
        finished_at    INTEGER,
        UNIQUE(user_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS image_jobs_owner ON image_jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS image_jobs_queue ON image_jobs(state, created_at, id);`);
}

/**
 * Creates the image job store.
 *
 * @param {{db: import('better-sqlite3').Database, now?: () => number}} options Options.
 * @returns {Object} Store API.
 */
export function createImageStore({ db, now = Date.now }) {
    initializeImageSchema(db);

    const statements = {
        byRequest: db.prepare('SELECT * FROM image_jobs WHERE user_id=? AND request_id=?'),
        byId: db.prepare('SELECT * FROM image_jobs WHERE id=?'),
        owned: db.prepare('SELECT * FROM image_jobs WHERE id=? AND user_id=?'),
        page: db.prepare('SELECT * FROM image_jobs WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?'),
        pageBefore: db.prepare('SELECT * FROM image_jobs WHERE user_id=? AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?'),
        pending: db.prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE state IN ('queued','running')"),
        queued: db.prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE state='queued'"),
        oldestQueued: db.prepare("SELECT * FROM image_jobs WHERE state='queued' ORDER BY created_at, id LIMIT 1"),
        start: db.prepare("UPDATE image_jobs SET state='running',started_at=?,updated_at=? WHERE id=? AND state='queued'"),
        succeed: db.prepare(`UPDATE image_jobs SET state='succeeded',file_name=?,mime_type=?,byte_size=?,width=?,height=?,
            upstream_ms=?,error_code=NULL,error_message=NULL,finished_at=?,updated_at=? WHERE id=?`),
        fail: db.prepare(`UPDATE image_jobs SET state='failed',error_code=?,error_message=?,finished_at=?,updated_at=?
            WHERE id=? AND state IN ('queued','running')`),
        interrupted: db.prepare(`UPDATE image_jobs SET state='failed',error_code='IMAGE_JOB_INTERRUPTED',
            error_message=?,finished_at=?,updated_at=? WHERE state='running'`),
        cancelled: db.prepare(`UPDATE image_jobs SET state='failed',error_code='IMAGE_JOB_CANCELLED',
            error_message=?,finished_at=?,updated_at=? WHERE state='queued'`),
    };

    const insert = db.prepare(`INSERT INTO image_jobs(id,user_id,request_id,input_hash,prompt,size_key,state,created_at,updated_at)
        VALUES(@id,@user_id,@request_id,@input_hash,@prompt,@size_key,'queued',@created_at,@updated_at)`);

    return {
        /**
         * @param {{userId: string, requestId: string, inputHash: string, prompt: string, sizeKey: string}} input Job input.
         * @returns {Object} The stored row.
         */
        insert(input) {
            const timestamp = now();
            const row = { id: randomUUID(), user_id: input.userId, request_id: input.requestId,
                input_hash: input.inputHash, prompt: input.prompt, size_key: input.sizeKey,
                created_at: timestamp, updated_at: timestamp };
            insert.run(row);
            return statements.byId.get(row.id);
        },
        findByRequest: (userId, requestId) => statements.byRequest.get(userId, requestId),
        findOwned: (id, userId) => statements.owned.get(id, userId),
        /** @param {string} id Job id. @returns {Object|undefined} Row regardless of owner (internal use). */
        find: id => statements.byId.get(id),
        /**
         * @param {string} userId Owner.
         * @param {{limit: number, before?: number}} options Pagination.
         * @returns {{rows: Object[], hasMore: boolean}} One page plus a look-ahead flag.
         */
        listOwned(userId, { limit, before }) {
            const rows = before === undefined || before === null
                ? statements.page.all(userId, limit + 1)
                : statements.pageBefore.all(userId, before, limit + 1);
            return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
        },
        pendingCount: () => statements.pending.get().count,
        queuedCount: () => statements.queued.get().count,
        /**
         * Atomically moves the oldest queued job to `running`.
         *
         * @returns {Object|null} The claimed row, or null when the queue is empty.
         */
        claimNext() {
            return db.transaction(() => {
                const row = statements.oldestQueued.get();
                if (!row) return null;
                const timestamp = now();
                const changed = statements.start.run(timestamp, timestamp, row.id);
                return changed.changes === 1 ? { ...row, state: 'running', started_at: timestamp } : null;
            })();
        },
        /**
         * @param {string} id Job id.
         * @param {{fileName: string, mimeType: string, byteSize: number, width: number|null, height: number|null, upstreamMs: number}} result Result metadata.
         * @returns {Object|undefined} Updated row.
         */
        markSucceeded(id, result) {
            const timestamp = now();
            statements.succeed.run(result.fileName, result.mimeType, result.byteSize, result.width, result.height,
                result.upstreamMs, timestamp, timestamp, id);
            return statements.byId.get(id);
        },
        /**
         * @param {string} id Job id.
         * @param {{code: string, message: string}} failure Classified failure.
         * @returns {Object|undefined} Updated row.
         */
        markFailed(id, failure) {
            const timestamp = now();
            statements.fail.run(failure.code, failure.message, timestamp, timestamp, id);
            return statements.byId.get(id);
        },
        /**
         * Startup repair. Nothing may stay `queued`/`running` forever, otherwise the panel
         * would spin indefinitely after a crash or deploy.
         *
         * @param {{interrupted: string, cancelled: string}} messages User-facing messages.
         * @returns {{interrupted: number, cancelled: number}} Repair counts.
         */
        repairAfterRestart(messages) {
            return db.transaction(() => {
                const timestamp = now();
                const interrupted = statements.interrupted.run(messages.interrupted, timestamp, timestamp);
                const cancelled = statements.cancelled.run(messages.cancelled, timestamp, timestamp);
                return { interrupted: interrupted.changes, cancelled: cancelled.changes };
            })();
        },
        /** @returns {{pending: number, queued: number}} Counters for `/api/health`. */
        counts: () => ({ pending: statements.pending.get().count, queued: statements.queued.get().count }),
    };
}
