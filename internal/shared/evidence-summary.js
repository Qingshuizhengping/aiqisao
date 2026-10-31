/**
 * @file Evidence badge summary (requirement R1-03/08).
 *
 * A pure function shared by the frontend (badge rendering) and the node tests. It reads a
 * message `metadata` object and returns a neutral description of what the answer leaned on.
 *
 * Guard rails, because this sits next to the audit-only presentation contract:
 *   - It never mutates the metadata it receives.
 *   - It never produces negative wording ("暂无依据" / "无法回答"): an answer with no
 *     documents simply has no badge.
 *   - It is exported from `shared/` so both the browser bundle and `node --test` can import
 *     it without a DOM.
 */

const MEMORY_LABELS = { personal: '个人记忆', project_private: '项目记忆', project_shared: '项目共享记忆' };

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function fileTitle(file) {
    if (!file || typeof file !== 'object') return '资料文件';
    return String(file.filename || file.name || file.title || '资料文件');
}

function memoryTitle(memory, index) {
    if (!memory || typeof memory !== 'object') return '记忆 ' + (index + 1);
    const scope = MEMORY_LABELS[memory.scope] || '记忆';
    const text = String(memory.content || '').replace(/\s+/g, ' ').trim();
    if (!text) return scope;
    return scope + '：' + (text.length > 40 ? text.slice(0, 40) + '…' : text);
}

function networkItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = String(entry.url || '').trim();
    if (!/^https:\/\//i.test(url)) return null;
    return { title: String(entry.title || url), url };
}

/**
 * @typedef {Object} EvidenceItem
 * @property {'file'|'memory'|'network'} kind Item category.
 * @property {string} label Badge text for the category.
 * @property {string} title Human readable title.
 * @property {string|null} url Source link for network items.
 */

/**
 * @typedef {Object} EvidenceSummary
 * @property {number} total Number of local sources (files + memories).
 * @property {string} label Badge text such as `参考 3 条资料`; empty when there is nothing.
 * @property {EvidenceItem[]} items Every source, local and network, in display order.
 * @property {{count: number, label: string, items: {title: string, url: string}[]}} network Network sources.
 * @property {{memory: boolean, knowledge: boolean, search: boolean}} degraded Degraded flags.
 */

/**
 * Summarizes a message's evidence metadata.
 *
 * @param {Object|null|undefined} metadata Message metadata (`{memories, files, search, ...}`).
 * @returns {EvidenceSummary} Summary; safe for any input, including `undefined`.
 */
export function evidenceSummary(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const memories = asArray(source.memories);
    const files = asArray(source.files);
    const search = source.search && typeof source.search === 'object' ? source.search : {};

    const items = [];
    for (const file of files) items.push({ kind: 'file', label: '资料', title: fileTitle(file), url: null });
    memories.forEach((memory, index) => items.push({ kind: 'memory', label: '记忆', title: memoryTitle(memory, index), url: null }));

    // Only a successful search may contribute sources; `degraded` and `disabled` never show
    // results (that is how "no empty citation block" is guaranteed).
    const networkItems = search.status === 'ok' ? asArray(search.items).map(networkItem).filter(Boolean) : [];
    for (const entry of networkItems) items.push({ kind: 'network', label: '网络', title: entry.title, url: entry.url });

    const total = files.length + memories.length;
    return {
        total,
        label: total > 0 ? '参考 ' + total + ' 条资料' : '',
        items,
        network: {
            count: networkItems.length,
            label: networkItems.length > 0 ? '来自网络 ' + networkItems.length + ' 条' : '',
            items: networkItems.map(entry => ({ title: entry.title, url: entry.url })),
        },
        degraded: {
            memory: Boolean(source.memoryDegraded ?? source.degraded?.memory),
            knowledge: Boolean(source.knowledgeDegraded ?? source.degraded?.knowledge),
            search: search.status === 'degraded' || Boolean(source.degraded?.search),
        },
    };
}
