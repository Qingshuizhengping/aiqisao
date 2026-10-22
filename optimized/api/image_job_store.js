import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { JOB_ID, TERMINAL_JOB_STATES, validateJobRecord } from './image_job_record.js';

export const DEFAULT_JOB_DIRECTORY = fileURLToPath(new URL('../var/image-jobs/', import.meta.url));
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const WINDOWS_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_RETRY_DELAYS = [10, 25, 50, 100];

export function createImageJobStore({ directory = DEFAULT_JOB_DIRECTORY, capacity = 64, queueCapacity = 8,
    retentionMs = 24 * 3600000, now = () => Date.now(), renameImpl = rename, platform = process.platform } = {}) {
    directory = path.resolve(directory);

    function filename(id) {
        return path.join(directory, id + '.json');
    }

    async function replace(temporary, target) {
        for (let attempt = 0; ; attempt++) {
            try { return await renameImpl(temporary, target); } catch (error) {
                if (platform !== 'win32' || !WINDOWS_REPLACE_ERRORS.has(error.code) || attempt >= REPLACE_RETRY_DELAYS.length) throw error;
                await delay(REPLACE_RETRY_DELAYS[attempt]);
            }
        }
    }

    async function persist(record) {
        const temporary = filename(record.id) + '.' + randomBytes(8).toString('hex') + '.tmp';
        let handle;
        try {
            handle = await open(temporary, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(record));
            await handle.sync();
            await handle.close();
            handle = null;
            await replace(temporary, filename(record.id));
            if (process.platform !== 'win32') {
                const parent = await open(directory, 'r');
                try { await parent.sync(); } finally { await parent.close(); }
            }
        } finally {
            await handle?.close().catch(() => {});
            await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    async function load() {
        let ancestor = directory;
        while (true) {
            const info = await lstat(ancestor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
            if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Invalid private image job directory ancestor');
            if (path.basename(ancestor).toLowerCase() === 'public') throw new Error('Image job storage must not be publicly served');
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid private image job directory');
        const resolved = await realpath(directory);
        if (path.resolve(resolved).toLowerCase() !== directory.toLowerCase()) throw new Error('Private image job directory must resolve without aliases');
        await chmod(directory, 0o700);
        const contents = await readdir(directory, { withFileTypes: true });
        for (const entry of contents) {
            if (!/^[0-9a-f-]{36}\.json\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue;
            if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid temporary private image job entry');
            await unlink(path.join(directory, entry.name));
        }
        const entries = contents.filter(entry => entry.name.endsWith('.json'));
        if (entries.length > capacity) throw new Error('Private image job capacity exceeded');
        const records = [];
        let outstandingCount = 0;
        for (const entry of entries) {
            const id = entry.name.slice(0, -5);
            if (!JOB_ID.test(id) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid private image job entry');
            const info = await lstat(filename(id));
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) throw new Error('Invalid private image job entry');
            await chmod(filename(id), 0o600);
            const record = JSON.parse(await readFile(filename(id), 'utf8'));
            validateJobRecord(record, id);
            if (!TERMINAL_JOB_STATES.has(record.state) && ++outstandingCount > queueCapacity) {
                throw new Error('Private image job queue capacity exceeded');
            }
            records.push(record);
        }
        return records;
    }

    async function prune(records) {
        const removed = [];
        for (const record of records) {
            if (TERMINAL_JOB_STATES.has(record.state) && record.updatedAt + retentionMs <= now()) {
                await unlink(filename(record.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
                removed.push(record.id);
            }
        }
        return removed;
    }

    return { directory, load, persist, prune };
}
