import { normalized, readVector, sensitive, vectorBuffer } from './memory-store.js';

function tokens(query) {
    const values = new Set(String(query).normalize('NFKC').toLowerCase().match(/[a-z\d_]{2,}|[\u3400-\u9fff]{2,}/g) || []);
    for (const value of [...values]) if (/^[\u3400-\u9fff]+$/.test(value)) {
        for (let index = 0; index < value.length - 1 && values.size < 100; index++) values.add(value.slice(index, index + 2));
    }
    return [...values].slice(0, 100);
}
export function createKnowledgeRetrieval({ db, model, access, embed }) {
    const { employee, project, controls } = access;
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

    return { retrieve, revalidate };
}
