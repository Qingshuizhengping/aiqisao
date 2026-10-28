import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APP_DIRECTORY, ENCRYPTED_MAGIC, decryptBackup, ensurePrivateDirectory, readBackupKey,
    requireRegularFile, sha256File, validateSnapshot } from './backup.mjs';

export async function runRestoreCheck({ env = process.env, inputPath, outputDirectory, keep = false } = {}) {
    if (!inputPath) throw new Error('An explicit --input backup file is required; live databases are never overwritten');
    const input = path.resolve(inputPath);
    requireRegularFile(input);
    const directory = outputDirectory ? ensurePrivateDirectory(outputDirectory)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'wzy-internal-restore-'));
    const restored = path.join(directory, 'restore-' + randomUUID() + '.sqlite');
    const header = Buffer.alloc(16);
    const descriptor = fs.openSync(input, 'r');
    try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
    const encrypted = header.subarray(0, 8).equals(ENCRYPTED_MAGIC);
    let success = false;
    try {
        if (encrypted) await decryptBackup(input, restored, readBackupKey(env, true));
        else {
            if (input.endsWith('.enc') || !header.equals(Buffer.from('SQLite format 3\u0000'))) throw new Error('Unsupported or damaged backup format');
            fs.copyFileSync(input, restored, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(restored, 0o600);
        }
        const verification = validateSnapshot(restored);
        let checksumVerified = false;
        if (!encrypted && fs.existsSync(input + '.json')) {
            const manifest = JSON.parse(fs.readFileSync(input + '.json', 'utf8'));
            if (manifest.format !== 'wzy-internal-sqlite-backup-v1' || manifest.sha256 !== await sha256File(restored)
                || manifest.size !== fs.statSync(restored).size
                || JSON.stringify(manifest.tableCounts) !== JSON.stringify(verification.tableCounts)) throw new Error('Backup manifest verification failed');
            checksumVerified = true;
        }
        success = true;
        return { event: 'restore_check_complete', verified: true, format: encrypted ? 'aes-256-gcm-v1' : 'sqlite',
            authenticatedEncryption: encrypted, checksumVerified, ...verification,
            kept: Boolean(keep), restoredPath: keep ? restored : null,
            warnings: encrypted ? [] : checksumVerified ? [] : ['No manifest was supplied. SQLite consistency was checked, but the snapshot checksum could not be authenticated.'] };
    } finally {
        if (!keep || !success) {
            for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(restored + suffix)) fs.unlinkSync(restored + suffix);
            if (!outputDirectory) fs.rmdirSync(directory);
        }
    }
}

function argumentsFrom(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--keep') { result.keep = true; continue; }
        const name = { '--input': 'inputPath', '--directory': 'outputDirectory' }[argv[index]];
        if (!name || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Use --input <backup>, optional --directory <private directory> and --keep');
        if (result[name]) throw new Error('Duplicate restore argument');
        result[name] = path.resolve(argv[++index]);
    }
    return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const envFile = path.join(APP_DIRECTORY, '.env');
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
        if (process.argv.includes('--help')) console.log('node scripts/restore-check.mjs --input FILE [--directory DIR] [--keep]');
        else console.log(JSON.stringify(await runRestoreCheck(argumentsFrom(process.argv.slice(2)))));
    } catch (error) {
        console.error(JSON.stringify({ event: 'restore_check_failed', message: error.message }));
        process.exitCode = 1;
    }
}
