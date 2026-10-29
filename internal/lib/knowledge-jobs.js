import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { sensitive, vectorBuffer } from './memory-store.js';
import { chunkKnowledgeText, parseKnowledgeFile } from './knowledge-parser.js';
import { fileFields, ERROR_MESSAGES } from './knowledge-store.js';

export function createKnowledgeEmbedding({ config, provider }) {
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

    return embed;
}

export function createKnowledgeJobs({ db, model, access, embed, parseFile = parseKnowledgeFile }) {
    const { jobStamp, eligible: authorized } = access;
    let started = false, stopping = false, timer = null, draining = null, controller = null;
    function eligible(row, version, stamp) { return stopping ? null : authorized(row, version, stamp); }
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
        const stamp = jobStamp(row);
        controller = new AbortController();
        try {
            if (!eligible(row, version, stamp)) fail(409, 'KNOWLEDGE_ACCESS_CHANGED', ERROR_MESSAGES.KNOWLEDGE_ACCESS_CHANGED);
            if (row.processing_state === 'queued') {
                db.prepare(`UPDATE knowledge_files SET processing_state='running',error_code=NULL,updated_at=? WHERE id=? AND version=?`).run(Date.now(), row.id, version);
                const original = db.prepare('SELECT original FROM knowledge_files WHERE id=? AND version=?').get(row.id, version)?.original;
                const text = await parseFile({ name: row.name, bytes: original, signal: controller.signal });
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
            const fresh = db.prepare('SELECT processing_state FROM knowledge_files WHERE id=? AND version=? AND status=? AND status IN (\'active\',\'candidate\')').get(row.id, version, row.status);
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
        controller?.abort(); await draining;
    }
    function health() {
        return { ready: true, running: Boolean(draining), queued: db.prepare(`SELECT COUNT(*) AS count FROM knowledge_files WHERE status IN ('active','candidate') AND
            (processing_state='queued' OR (status='active' AND processing_state='ready' AND index_state='queued'))`).get().count,
            failed: db.prepare(`SELECT COUNT(*) AS count FROM knowledge_files WHERE status<>'deleted' AND (processing_state IN ('failed','interrupted') OR index_state='failed')`).get().count };
    }
    return { start, stop, health, schedule };
}
