const DEFAULT_KEY = 'qisao_studio_history';
const MAX_ENTRIES = 36;
const MAX_PROMPT = 4000;

function validImageUrl(value) {
    if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    const relative = value.startsWith('/') && !value.startsWith('//');
    if (!relative && !/^https?:\/\//i.test(value)) return false;
    try {
        const url = new URL(value, 'https://studio.invalid');
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
        return false;
    }
}

function normalizeEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validImageUrl(value.url) ||
        typeof value.prompt !== 'string' || value.prompt.length > MAX_PROMPT || !Number.isFinite(value.ts) || value.ts < 0) return null;
    const entry = { url: value.url, prompt: value.prompt, ts: value.ts };
    for (const field of ['originalPrompt', 'optimizedPrompt']) {
        if (value[field] !== undefined) {
            if (typeof value[field] !== 'string' || value[field].length > MAX_PROMPT) return null;
            entry[field] = value[field];
        }
    }
    return entry;
}

function copyEntries(entries) {
    return entries.map(entry => ({ ...entry }));
}

export function createStudioHistoryStore({ storage, key = DEFAULT_KEY, maxEntries = MAX_ENTRIES }) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('历史存储需要 getItem 和 setItem 方法。');
    if (typeof key !== 'string' || !key) throw new TypeError('历史存储键不能为空。');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new RangeError('历史记录上限必须为 1 至 36。');
    let reliableEntries = [];

    function failed(code, message) {
        return { ok: false, entries: copyEntries(reliableEntries), error: { code, message } };
    }

    function succeeded(entries) {
        reliableEntries = copyEntries(entries);
        return { ok: true, entries: copyEntries(reliableEntries) };
    }

    function load() {
        let raw;
        try {
            raw = storage.getItem(key);
        } catch {
            return failed('HISTORY_READ_FAILED', '无法读取本地历史，已保留此前记录，请检查浏览器存储权限。');
        }
        if (raw === null || raw === undefined) return succeeded([]);
        let entries;
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('Invalid history');
            entries = [];
            const urls = new Set();
            for (const value of parsed) {
                const entry = normalizeEntry(value);
                if (!entry) throw new Error('Invalid entry');
                if (!urls.has(entry.url)) {
                    urls.add(entry.url);
                    if (entries.length < maxEntries) entries.push(entry);
                }
            }
        } catch {
            return failed('HISTORY_DATA_INVALID', '本地历史格式异常，未覆盖原有数据，请先备份后处理。');
        }
        return succeeded(entries);
    }

    function persist(entries) {
        try {
            storage.setItem(key, JSON.stringify(entries));
        } catch {
            return failed('HISTORY_WRITE_FAILED', '本地历史保存失败，原有记录未清除；新图片请先下载保存。');
        }
        return succeeded(entries);
    }

    function append(value) {
        const current = load();
        if (!current.ok) return current;
        let entry;
        try { entry = normalizeEntry(value); } catch {}
        if (!entry) return failed('HISTORY_ENTRY_INVALID', '生成记录格式无效，未写入或覆盖本地历史。');
        return persist([entry, ...current.entries.filter(previous => previous.url !== entry.url)].slice(0, maxEntries));
    }

    function clear() {
        const current = load();
        if (!current.ok) return current;
        return persist([]);
    }

    return { load, append, clear };
}
