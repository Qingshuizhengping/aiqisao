import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDatabase } from '../lib/database.js';
import { APP_DIRECTORY, runBackup, readBackupKey } from '../scripts/backup.mjs';
import { runRestoreCheck } from '../scripts/restore-check.mjs';
import { initializeGroundingSchema } from '../lib/grounding-store.js';

function fixture(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-backup-test-'));
    const dataDirectory = path.join(directory, 'data');
    const databasePath = path.join(dataDirectory, 'internal.sqlite');
    const db = openDatabase(databasePath);
    db.pragma('wal_autocheckpoint = 0');
    const userId = randomUUID();
    const conversationId = randomUUID();
    const time = Date.now();
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(userId, 'synthetic', 'Synthetic', 'fixture-only', time, time);
    db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(conversationId, userId, 'Synthetic backup record', time, time);
    db.prepare('INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), conversationId, 'user', 'SYNTHETIC_PRIVATE_CONTENT_' + 'x'.repeat(12000), 'complete', time, time);
    const env = { INTERNAL_DATA_DIRECTORY: dataDirectory, INTERNAL_BACKUP_DIRECTORY: path.join(directory, 'backups') };
    context.after(() => {
        db.close();
        const relative = path.relative(os.tmpdir(), directory);
        assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
        assert.ok(path.basename(directory).startsWith('wzy-backup-test-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { directory, db, env, databasePath, userId, conversationId };
}

test('online backup includes committed WAL records, verifies all core tables, and restores independently', async context => {
    const setup = fixture(context);
    assert.ok(fs.statSync(setup.databasePath + '-wal').size > 0);
    const backup = await runBackup({ env: setup.env });
    assert.equal(backup.integrity, 'ok');
    assert.equal(backup.foreignKeys, 'ok');
    assert.equal(backup.tableCounts.messages, 1);
    assert.equal(backup.offsiteProtection, 'not_configured');
    assert.equal(backup.encryptedExport, null);
    assert.match(backup.warnings[0], /not satisfied/);
    setup.db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(randomUUID(), setup.userId, 'Written after snapshot', Date.now(), Date.now());
    const restore = await runRestoreCheck({ inputPath: backup.backup, outputDirectory: path.join(setup.directory, 'drill'), keep: true });
    assert.equal(restore.verified, true);
    assert.equal(restore.checksumVerified, true);
    assert.equal(restore.tableCounts.conversations, 1);
    const recovered = new Database(restore.restoredPath, { readonly: true });
    try { assert.match(recovered.prepare('SELECT content FROM messages').get().content, /^SYNTHETIC_PRIVATE_CONTENT_/); }
    finally { recovered.close(); }
    assert.equal(setup.db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 2);
    if (os.platform() !== 'win32') {
        assert.equal(fs.statSync(backup.backup).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(backup.backup)).mode & 0o777, 0o700);
    }
});

test('AES-GCM export round trips and rejects wrong keys and modified ciphertext without retaining plaintext', async context => {
    const setup = fixture(context);
    const key = Buffer.alloc(32, 42).toString('base64');
    const env = { ...setup.env, BACKUP_ENCRYPTION_KEY: key, BACKUP_EXPORT_DIRECTORY: path.join(setup.directory, 'export') };
    const backup = await runBackup({ env });
    assert.ok(backup.encryptedExport);
    assert.equal(backup.offsiteProtection, 'unverified');
    assert.equal(backup.separateFilesystem, false);
    const bytes = fs.readFileSync(backup.encryptedExport);
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_CONTENT_')), false);
    const restore = await runRestoreCheck({ env, inputPath: backup.encryptedExport });
    assert.equal(restore.authenticatedEncryption, true);
    assert.equal(restore.tableCounts.messages, 1);
    assert.equal(restore.restoredPath, null);
    const outputDirectory = path.join(setup.directory, 'failed-drill');
    await assert.rejects(runRestoreCheck({ env: { BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 99).toString('base64') },
        inputPath: backup.encryptedExport, outputDirectory }), /authenticate|auth/i);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
    bytes[bytes.length - 30] ^= 1;
    const damaged = path.join(setup.directory, 'tampered.enc');
    fs.writeFileSync(damaged, bytes);
    await assert.rejects(runRestoreCheck({ env, inputPath: damaged, outputDirectory }), /authenticate|auth/i);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('confirmed source and fact histories survive an encrypted backup and independent restore', async context => {
    const setup = fixture(context); initializeGroundingSchema(setup.db);
    const now = Date.now(), source = randomUUID(), confirmation = randomUUID(), fact = randomUUID();
    setup.db.prepare('INSERT INTO source_confirmations(id,source_type,source_id,source_version,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?)')
        .run(confirmation,'memory',source,3,setup.userId,now);
    setup.db.prepare(`INSERT INTO standard_facts(id,scope,user_id,entity,field,value,unit,conditions,valid_from,valid_until,
        source_type,source_id,source_version,source_confirmation_id,evidence,status,version,confirmed_by,confirmed_at,created_by,created_at,updated_at)
        VALUES(?,'personal',?,'合成产品','零售价','168.00','元/瓶','仅用于合成验收','2026-01-01','2026-12-31','memory',?,3,?,'合成产品零售价168.00元/瓶。','confirmed',2,?,?,?,?,?)`)
        .run(fact,setup.userId,source,confirmation,setup.userId,now,setup.userId,now,now);
    setup.db.prepare(`INSERT INTO fact_confirmations(id,fact_id,fact_version,source_type,source_id,source_version,source_confirmation_id,confirmed_by,confirmed_at,canonical_value)
        VALUES(?,?,2,'memory',?,3,?,?,?,?)`).run(randomUUID(),fact,source,confirmation,setup.userId,now,JSON.stringify({value:'168.00',unit:'元/瓶'}));
    const env = {...setup.env,BACKUP_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64'),BACKUP_EXPORT_DIRECTORY:path.join(setup.directory,'export')};
    const backup = await runBackup({env});
    const restored = await runRestoreCheck({env,inputPath:backup.encryptedExport,outputDirectory:path.join(setup.directory,'drill'),keep:true});
    for (const table of ['source_confirmations','standard_facts','fact_confirmations']) assert.equal(restored.tableCounts[table],1);
    const recovered = new Database(restored.restoredPath,{readonly:true});
    try {
        const row = recovered.prepare('SELECT * FROM standard_facts').get();
        assert.equal(row.value,'168.00'); assert.equal(row.source_confirmation_id,confirmation);
        assert.equal(row.valid_until,'2026-12-31');
        assert.equal(JSON.parse(recovered.prepare('SELECT canonical_value FROM fact_confirmations').get().canonical_value).unit,'元/瓶');
    } finally { recovered.close(); }
});

test('local retention removes only generated backups older than fourteen days and leaves external copies intact', async context => {
    const setup = fixture(context);
    const time = Date.now();
    const old = await runBackup({ env: setup.env, timestamp: time - 15 * 86400000 });
    const boundary = await runBackup({ env: setup.env, timestamp: time - 14 * 86400000 });
    const unrelated = path.join(path.dirname(old.backup), 'unrelated.sqlite');
    fs.writeFileSync(unrelated, 'Must survive retention');
    const current = await runBackup({ env: setup.env, timestamp: time });
    assert.equal(current.localRetentionDays, 14);
    assert.equal(current.removedLocalFiles, 2);
    assert.equal(fs.existsSync(old.backup), false);
    assert.equal(fs.existsSync(old.manifest), false);
    assert.equal(fs.existsSync(boundary.backup), true);
    assert.equal(fs.existsSync(unrelated), true);
});

test('missing export keys, invalid key encoding and invalid databases fail before reporting success', async context => {
    const setup = fixture(context);
    await assert.rejects(runBackup({ env: { ...setup.env, BACKUP_EXPORT_DIRECTORY: path.join(setup.directory, 'export') } }), /BACKUP_ENCRYPTION_KEY/);
    assert.equal(fs.existsSync(setup.env.INTERNAL_BACKUP_DIRECTORY), false);
    assert.throws(() => readBackupKey({ BACKUP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64').replace(/=+$/, '') }), /canonical/);
    const invalid = path.join(setup.directory, 'invalid.sqlite');
    const other = new Database(invalid);
    other.exec('CREATE TABLE unrelated(id TEXT)');
    other.close();
    await assert.rejects(runBackup({ env: setup.env, databasePath: invalid }), /missing required/);
    assert.deepEqual(fs.readdirSync(setup.env.INTERNAL_BACKUP_DIRECTORY), []);
});

test('restore refuses malformed backups and manifest mismatches and never overwrites a live database', async context => {
    const setup = fixture(context);
    const backup = await runBackup({ env: setup.env });
    const original = fs.readFileSync(setup.databasePath);
    const manifest = JSON.parse(fs.readFileSync(backup.manifest, 'utf8'));
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(backup.manifest, JSON.stringify(manifest));
    const outputDirectory = path.join(setup.directory, 'restore');
    await assert.rejects(runRestoreCheck({ inputPath: backup.backup, outputDirectory, keep: true }), /manifest/);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
    assert.deepEqual(fs.readFileSync(setup.databasePath), original);
    const malformed = path.join(setup.directory, 'wrong.enc');
    fs.writeFileSync(malformed, 'WZYBK001bad');
    await assert.rejects(runRestoreCheck({ inputPath: malformed, env: { BACKUP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') } }), /truncated/);
    await assert.rejects(runRestoreCheck(), /explicit --input/);
});

test('backup and restore command line tools execute against synthetic data without provider configuration', async context => {
    const setup = fixture(context);
    const env = { ...process.env, ...setup.env, BACKUP_EXPORT_DIRECTORY: '', BACKUP_ENCRYPTION_KEY: '' };
    const stdout = execFileSync(process.execPath, [path.join(APP_DIRECTORY, 'scripts/backup.mjs')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const backup = JSON.parse(stdout);
    assert.equal(backup.event, 'backup_complete');
    const checked = execFileSync(process.execPath, [path.join(APP_DIRECTORY, 'scripts/restore-check.mjs'), '--input', backup.backup],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(checked).verified, true);
});
