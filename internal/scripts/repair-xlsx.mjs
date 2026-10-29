import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseKnowledgeFile, chunkKnowledgeText } from '../lib/knowledge-parser.js';
import { sensitive } from '../lib/memory-store.js';
import { createKnowledgeAccess } from '../lib/knowledge-access.js';
import { ensurePrivateDirectory, requireRegularFile } from './backup.mjs';

export const XLSX_REPAIR_VERSION = 'xlsx-sparse-columns-v1';
const APP_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

function privateDirectory(directory) {
    const resolved = path.resolve(directory);
    if (resolved.split(/[\\/]/).some(part => /^(?:public|dist|static)$/i.test(part))) {
        throw new Error('Repair receipts must be outside public, dist and static directories');
    }
    return ensurePrivateDirectory(resolved);
}

function readJournal(filename) {
    if (!fs.existsSync(filename)) return { parser: XLSX_REPAIR_VERSION, files: {} };
    const info = requireRegularFile(filename);
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Repair receipts must have private 0600 permissions');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.parser !== XLSX_REPAIR_VERSION || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
        throw new Error('Unsupported XLSX repair receipt');
    }
    return value;
}

function writeJournal(filename, journal) {
    const temporary = filename + '.partial-' + randomUUID();
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(journal, null, 2) + '\n');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, filename);
        if (process.platform !== 'win32') {
            const directory = fs.openSync(path.dirname(filename), 'r');
            try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function sourceHash(row) {
    return digest(JSON.stringify([row.scope, row.user_id, row.project_id, row.name, row.sha256, digest(row.original)]));
}

function parsedHash(text, chunks) { return digest(JSON.stringify([text, chunks])); }

function acquireLock(directory) {
    const filename = path.join(directory, XLSX_REPAIR_VERSION + '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
        let descriptor;
        try {
            descriptor = fs.openSync(filename, 'wx', 0o600);
            const token = randomUUID();
            fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            return () => {
                requireRegularFile(filename);
                if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename);
            };
        } catch (error) {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            if (error.code !== 'EEXIST') throw error;
            requireRegularFile(filename);
            const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!Number.isSafeInteger(current.pid) || current.pid <= 0) throw new Error('Invalid XLSX repair lock');
            try { process.kill(current.pid, 0); }
            catch (probe) {
                if (probe.code !== 'ESRCH') throw new Error('An XLSX repair may already be running');
                // Only retire a lock whose process no longer exists. Its intent
                // journal remains available for deterministic crash recovery.
                fs.unlinkSync(filename);
                continue;
            }
            throw new Error('An XLSX repair is already running');
        }
    }
    throw new Error('Could not acquire XLSX repair lock');
}

// This command never creates a provider client. It only replaces persisted parsed
// text and queues normal indexing; the service can drain it after the repair.
export async function repairXlsx(options = {}) {
    const directory = privateDirectory(options.receiptDirectory);
    const release = acquireLock(directory);
    try { return await performRepair({ ...options, receiptDirectory: directory }); }
    finally { release(); }
}

async function performRepair({ db, receiptDirectory, parseFile = parseKnowledgeFile, signal }) {
    const directory = privateDirectory(receiptDirectory);
    const filename = path.join(directory, XLSX_REPAIR_VERSION + '.json');
    const journal = readJournal(filename);
    const access = createKnowledgeAccess({ db });
    const summary = { repaired: 0, alreadyRepaired: 0, deferred: 0, failed: 0, skipped: 0 };
    const rows = db.prepare("SELECT id FROM knowledge_files WHERE extension='xlsx' ORDER BY id").all();
    let receiptFailure = false;

    function receipt(id, value) {
        journal.files[id] = { ...value, updatedAt: Date.now() };
        receiptFailure = true;
        writeJournal(filename, journal);
        receiptFailure = false;
    }
    function unavailable(row) {
        if (!row || row.status === 'deleted') return 'deleted';
        if (!row.original) return 'missing_original';
        if (row.project_id && db.prepare('SELECT archived FROM projects WHERE id=?').get(row.project_id)?.archived) return 'archived';
        if (row.processing_state === 'running' || row.index_state === 'running') return 'busy';
        if (!access.eligible(row, row.version, access.jobStamp(row))) return 'access_changed';
        return null;
    }

    for (const { id } of rows) {
        signal?.throwIfAborted();
        let row = db.prepare('SELECT * FROM knowledge_files WHERE id=?').get(id);
        const reason = unavailable(row);
        if (reason) {
            if (reason === 'deleted') summary.skipped++; else summary.deferred++;
            // Keep a completed/intent receipt intact so temporarily unavailable
            // files do not lose their idempotency marker.
            if (!['completed', 'intent'].includes(journal.files[id]?.state)) receipt(id, { state: 'deferred', reason });
            continue;
        }
        const originalHash = sourceHash(row);
        const previous = journal.files[id];
        if (previous?.sourceHash === originalHash && previous.targetVersion === row.version && ['completed', 'intent'].includes(previous.state)) {
            const chunks = db.prepare('SELECT content,file_version FROM knowledge_chunks WHERE file_id=? ORDER BY chunk_index').all(id);
            if (chunks.length === row.chunk_count && chunks.every(chunk => chunk.file_version === row.version)
                && parsedHash(row.text_content, chunks.map(chunk => chunk.content)) === previous.parsedHash) {
                if (previous.state === 'intent') receipt(id, { ...previous, state: 'completed', recovered: true });
                summary.alreadyRepaired++;
                continue;
            }
        }

        const version = row.version;
        const status = row.status;
        const stamp = access.jobStamp(row);
        try {
            const text = await parseFile({ name: row.name, bytes: row.original, signal });
            signal?.throwIfAborted();
            if (sensitive(text)) throw Object.assign(new Error('Credential-bearing document'), { code: 'KNOWLEDGE_SECRET_BLOCKED' });
            const chunks = chunkKnowledgeText(text);
            const targetVersion = version + 1;
            const intent = { state: 'intent', sourceHash: originalHash, sourceVersion: version,
                targetVersion, parsedHash: parsedHash(text, chunks) };
            // Persist intent before committing. A crash after the DB commit can
            // be recognized from the target version and exact parsed digest.
            receipt(id, intent);
            const changed = db.transaction(() => {
                row = db.prepare('SELECT * FROM knowledge_files WHERE id=?').get(id);
                if (unavailable(row) || row.version !== version || row.status !== status || sourceHash(row) !== originalHash
                    || !access.eligible(row, version, stamp)) return false;
                db.prepare('DELETE FROM knowledge_chunks WHERE file_id=?').run(id);
                const insert = db.prepare('INSERT INTO knowledge_chunks(id,file_id,file_version,chunk_index,content) VALUES(?,?,?,?,?)');
                chunks.forEach((content, index) => insert.run(randomUUID(), id, targetVersion, index, content));
                db.prepare(`UPDATE knowledge_files SET text_content=?,version=?,chunk_count=?,character_count=?,
                    processing_state='ready',index_state='queued',error_code=NULL,updated_at=? WHERE id=? AND version=? AND status=?`)
                    .run(text, targetVersion, chunks.length, text.length, Date.now(), id, version, status);
                return true;
            })();
            if (changed) {
                receipt(id, { ...intent, state: 'completed' });
                summary.repaired++;
            } else {
                receipt(id, { state: 'deferred', reason: 'source_changed' });
                summary.deferred++;
            }
        } catch (error) {
            if (signal?.aborted || receiptFailure) throw error;
            receipt(id, { state: 'failed', sourceHash: originalHash, sourceVersion: version,
                errorCode: /^KNOWLEDGE_[A-Z_]+$/.test(error.code || '') ? error.code : 'XLSX_REPAIR_FAILED' });
            summary.failed++;
        }
    }
    return summary;
}

async function main() {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        if (!['--database', '--receipt-directory'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: repair-xlsx.mjs [--database PATH] [--receipt-directory PRIVATE_PATH]');
        options[args[index]] = args[index + 1];
    }
    const dataDirectory = path.resolve(APP_DIRECTORY, process.env.INTERNAL_DATA_DIRECTORY || 'var');
    const databasePath = path.resolve(options['--database'] || path.join(dataDirectory, 'internal.sqlite'));
    requireRegularFile(databasePath);
    const db = new Database(databasePath, { fileMustExist: true });
    try {
        db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
        const result = await repairXlsx({ db, receiptDirectory: options['--receipt-directory'] || path.join(path.dirname(databasePath), 'maintenance-receipts') });
        process.stdout.write(JSON.stringify({ parser: XLSX_REPAIR_VERSION, ...result }) + '\n');
        if (result.failed) process.exitCode = 1;
    } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => { process.stderr.write('XLSX repair did not complete; inspect the private receipt and retry.\n'); process.exitCode = 1; });
}
