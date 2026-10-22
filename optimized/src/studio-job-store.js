export const LEGACY_JOB_KEY = 'qisao_studio_pending_job';
export const JOB_KEY_PREFIX = 'qisao_studio_job:';

export function isJobRecord(record) {
    return !!record && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) &&
        /^[0-9a-f]{64}$/.test(record.token) && typeof record.prompt === 'string' && !!record.prompt.trim() && record.prompt.length <= 4000 &&
        ['auto', '1:1', '3:4', '4:3', '9:16', '16:9'].includes(record.size) &&
        Number.isInteger(record.referenceCount) && record.referenceCount >= 0 && record.referenceCount <= 20 &&
        Number.isFinite(record.createdAt) && typeof record.accepted === 'boolean' && typeof record.optimizationEnabled === 'boolean';
}

function parseRecord(raw) {
    try {
        const record = JSON.parse(raw);
        return isJobRecord(record) ? record : null;
    } catch {
        return null;
    }
}

export function createStudioJobStore(storage) {
    function read(id) {
        const record = parseRecord(storage.getItem(JOB_KEY_PREFIX + id));
        return record?.id === id ? record : null;
    }

    function create(record) {
        if (!isJobRecord(record)) throw new Error('后台任务凭据无效。');
        const existing = read(record.id);
        if (existing && existing.token !== record.token) throw new Error('后台任务标识冲突，请重新提交。');
        if (!existing) storage.setItem(JOB_KEY_PREFIX + record.id, JSON.stringify(record));
    }

    function migrateLegacy() {
        const raw = storage.getItem(LEGACY_JOB_KEY);
        if (!raw) return;
        const record = parseRecord(raw);
        if (!record) {
            if (storage.getItem(LEGACY_JOB_KEY) === raw) storage.removeItem(LEGACY_JOB_KEY);
            return;
        }
        create(record);
        if (storage.getItem(LEGACY_JOB_KEY) === raw) storage.removeItem(LEGACY_JOB_KEY);
    }

    function list() {
        const records = [];
        try { migrateLegacy(); } catch {
            const legacy = parseRecord(storage.getItem(LEGACY_JOB_KEY));
            if (legacy) records.push(legacy);
        }
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (!key?.startsWith(JOB_KEY_PREFIX)) continue;
            const record = read(key.slice(JOB_KEY_PREFIX.length));
            if (record && !records.some(existing => existing.id === record.id)) records.push(record);
        }
        return records.sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    }

    function accept(record) {
        const existing = read(record.id);
        if (existing?.token === record.token && !existing.accepted) {
            storage.setItem(JOB_KEY_PREFIX + record.id, JSON.stringify({ ...existing, accepted: true }));
        }
    }

    function remove(record) {
        if (read(record.id)?.token === record.token) storage.removeItem(JOB_KEY_PREFIX + record.id);
        const raw = storage.getItem(LEGACY_JOB_KEY);
        const legacy = parseRecord(raw);
        if (legacy?.id === record.id && legacy.token === record.token && storage.getItem(LEGACY_JOB_KEY) === raw) storage.removeItem(LEGACY_JOB_KEY);
    }

    return { create, read, list, accept, remove, matchesKey: key => key === null || key === LEGACY_JOB_KEY || key.startsWith(JOB_KEY_PREFIX) };
}
