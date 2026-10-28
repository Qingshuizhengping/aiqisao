import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const APP_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
export const ENCRYPTED_MAGIC = Buffer.from('WZYBK001');
const RETENTION_MS = 14 * 86400000;
const CORE_TABLES = ['users', 'sessions', 'projects', 'project_members', 'conversations', 'messages', 'chat_runs', 'audit_records'];

export function readBackupKey(env = process.env, required = false) {
    const encoded = env.BACKUP_ENCRYPTION_KEY || '';
    if (!encoded && !required) return null;
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('BACKUP_ENCRYPTION_KEY must be a canonical 32-byte base64 key');
    return key;
}

export function ensurePrivateDirectory(directory) {
    const resolved = path.resolve(directory);
    if (resolved === path.parse(resolved).root) throw new Error('A dedicated private backup directory is required');
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup directory must be a regular directory, not a symlink');
    if (os.platform() !== 'win32' && (info.mode & 0o077)) throw new Error('Backup directory must have private 0700 permissions');
    return resolved;
}

export function requireRegularFile(filename) {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup input must be a regular file, not a symlink');
    return info;
}

export async function sha256File(filename) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

export function validateSnapshot(filename) {
    requireRegularFile(filename);
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
        db.pragma('query_only = ON');
        const integrity = db.pragma('integrity_check');
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity verification failed');
        if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign-key verification failed');
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
        if (CORE_TABLES.some(name => !names.includes(name))) throw new Error('The backup is missing required internal application tables');
        const counts = {};
        for (const name of names) counts[name] = db.prepare('SELECT COUNT(*) AS count FROM "' + name.replaceAll('"', '""') + '"').get().count;
        return { integrity: 'ok', foreignKeys: 'ok', userVersion: db.pragma('user_version', { simple: true }), tableCounts: counts };
    } finally { db.close(); }
}

function syncFile(filename) {
    const descriptor = fs.openSync(filename, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory) {
    if (os.platform() === 'win32') return;
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export async function encryptBackup(input, output, key) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(ENCRYPTED_MAGIC);
    const temporary = output + '.partial-' + randomUUID();
    try {
        fs.writeFileSync(temporary, Buffer.concat([ENCRYPTED_MAGIC, nonce]), { flag: 'wx', mode: 0o600 });
        await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
        fs.appendFileSync(temporary, cipher.getAuthTag());
        syncFile(temporary);
        if (fs.existsSync(output)) throw new Error('Encrypted backup destination already exists');
        fs.renameSync(temporary, output);
        syncDirectory(path.dirname(output));
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export async function decryptBackup(input, output, key) {
    const info = requireRegularFile(input);
    if (info.size <= ENCRYPTED_MAGIC.length + 12 + 16) throw new Error('Encrypted backup is truncated');
    const descriptor = fs.openSync(input, 'r');
    const header = Buffer.alloc(20);
    const tag = Buffer.alloc(16);
    try {
        if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
            || fs.readSync(descriptor, tag, 0, tag.length, info.size - tag.length) !== tag.length
            || !header.subarray(0, 8).equals(ENCRYPTED_MAGIC)) throw new Error('Unsupported encrypted backup format');
    } finally { fs.closeSync(descriptor); }
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
    decipher.setAAD(ENCRYPTED_MAGIC);
    decipher.setAuthTag(tag);
    const temporary = output + '.partial-' + randomUUID();
    try {
        await pipeline(fs.createReadStream(input, { start: 20, end: info.size - 17 }), decipher,
            fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        syncFile(temporary);
        if (fs.existsSync(output)) throw new Error('Restore destination already exists');
        fs.renameSync(temporary, output);
        syncDirectory(path.dirname(output));
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function pruneLocalBackups(directory, timestamp) {
    let removed = 0;
    for (const name of fs.readdirSync(directory)) {
        const match = /^internal-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite(?:\.json|\.enc)?$/.exec(name);
        if (!match || Number(match[1]) >= timestamp - RETENTION_MS) continue;
        const filename = path.join(directory, name);
        const info = fs.lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        fs.unlinkSync(filename);
        removed++;
    }
    syncDirectory(directory);
    return removed;
}

export async function runBackup({ env = process.env, databasePath, backupDirectory, exportDirectory, timestamp = Date.now() } = {}) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 1000000000000 || timestamp > 9999999999999) throw new Error('Invalid backup timestamp');
    const dataDirectory = path.resolve(APP_DIRECTORY, env.INTERNAL_DATA_DIRECTORY || 'var');
    const source = path.resolve(databasePath || path.join(dataDirectory, 'internal.sqlite'));
    const sourceInfo = requireRegularFile(source);
    const requestedExport = exportDirectory ?? env.BACKUP_EXPORT_DIRECTORY;
    const key = readBackupKey(env, Boolean(requestedExport));
    const directory = ensurePrivateDirectory(backupDirectory || path.resolve(APP_DIRECTORY, env.INTERNAL_BACKUP_DIRECTORY || path.join(dataDirectory, 'backups')));
    const externalDirectory = requestedExport ? ensurePrivateDirectory(path.resolve(APP_DIRECTORY, requestedExport)) : null;
    const base = 'internal-' + timestamp + '-' + randomUUID() + '.sqlite';
    const destination = path.join(directory, base);
    const temporary = destination + '.partial-' + randomUUID();
    let sourceDb;
    let snapshot;
    try {
        fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
        sourceDb = new Database(source, { readonly: true, fileMustExist: true });
        sourceDb.pragma('busy_timeout = 5000');
        await sourceDb.backup(temporary);
        sourceDb.close();
        sourceDb = null;
        fs.chmodSync(temporary, 0o600);
        snapshot = validateSnapshot(temporary);
        syncFile(temporary);
        fs.renameSync(temporary, destination);
        syncDirectory(directory);
    } finally {
        sourceDb?.close();
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    const manifest = { format: 'wzy-internal-sqlite-backup-v1', createdAt: timestamp,
        sha256: await sha256File(destination), size: fs.statSync(destination).size, ...snapshot };
    fs.writeFileSync(destination + '.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(destination + '.json');
    let encryptedExport = null;
    let separateFilesystem = false;
    const warnings = [];
    if (externalDirectory) {
        encryptedExport = path.join(externalDirectory, base + '.enc');
        await encryptBackup(destination, encryptedExport, key);
        separateFilesystem = fs.statSync(externalDirectory).dev !== sourceInfo.dev;
        warnings.push(separateFilesystem
            ? 'Encrypted export written to another filesystem. Verify that this mount is off-host and independently retained before claiming offsite protection.'
            : 'Encrypted export is on the source filesystem. This does not satisfy offsite protection.');
    } else {
        warnings.push('BACKUP_EXPORT_DIRECTORY is not configured. No encrypted offsite copy was created; offsite protection is not satisfied.');
    }
    const removedLocalFiles = pruneLocalBackups(directory, timestamp);
    return { event: 'backup_complete', backup: destination, manifest: destination + '.json', createdAt: timestamp,
        integrity: snapshot.integrity, foreignKeys: snapshot.foreignKeys, tableCounts: snapshot.tableCounts,
        localRetentionDays: 14, removedLocalFiles, encryptedExport, separateFilesystem,
        offsiteProtection: externalDirectory ? 'unverified' : 'not_configured', warnings };
}

function argumentsFrom(argv) {
    const result = {};
    const names = { '--database': 'databasePath', '--directory': 'backupDirectory', '--export-directory': 'exportDirectory' };
    for (let index = 0; index < argv.length; index++) {
        const name = names[argv[index]];
        if (!name || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Use --database <file>, --directory <directory> or --export-directory <directory>');
        if (result[name]) throw new Error('Duplicate backup argument');
        result[name] = path.resolve(argv[++index]);
    }
    return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const envFile = path.join(APP_DIRECTORY, '.env');
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
        if (process.argv.includes('--help')) console.log('node scripts/backup.mjs [--database FILE] [--directory DIR] [--export-directory DIR]');
        else {
            const result = await runBackup(argumentsFrom(process.argv.slice(2)));
            console.log(JSON.stringify(result));
            for (const warning of result.warnings) console.warn(warning);
        }
    } catch (error) {
        console.error(JSON.stringify({ event: 'backup_failed', message: error.message }));
        process.exitCode = 1;
    }
}
