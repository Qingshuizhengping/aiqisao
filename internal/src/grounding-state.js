import { createLifecycleOwner } from './selection-lifecycle.js';

export const groundingStages = { retrieving: '正在查找资料…', drafting: '正在整理有据内容…', verifying: '正在核对依据…' };
export const groundingStatuses = { verified: '已核验', partial: '部分内容已核验', insufficient: '依据不足', conflict: '资料冲突', unavailable: '暂时无法核实' };

export function groundingPresentation(message) {
    const grounding = message?.metadata?.grounding;
    return { pending: message?.role !== 'user' && grounding?.status === 'pending',
        progress: groundingStages[grounding?.stage] || '正在核对依据…',
        status: grounding?.status === 'verified' && grounding?.basis === 'user_input' ? '已核对原文' : groundingStatuses[grounding?.status] || '',
        tone: grounding?.status === 'verified' ? 'accent' : 'warning',
        citations: Array.isArray(grounding?.citations) ? grounding.citations.filter(item => item && typeof item === 'object') : [] };
}

export function sourceIdentity(source) {
    const type = source?.sourceType || source?.type;
    const sourceId = source?.sourceId || (typeof source?.id === 'string' ? source.id.replace(/^(?:memory|file):/, '') : '');
    return ['memory', 'file'].includes(type) && typeof sourceId === 'string' && sourceId ? { type, sourceId } : null;
}

export function sourceRoute(source) {
    const identity = sourceIdentity(source);
    if (!identity) throw new Error('来源标识无效。');
    return '/api/grounding/sources/' + identity.type + '/' + encodeURIComponent(identity.sourceId);
}

export function sourceVersionChanged(reference, source) {
    return Number.isInteger(reference?.version) && reference.version !== source?.version;
}

export function citationNumber(citation, index) {
    return Number.isSafeInteger(citation?.number) && citation.number > 0 ? citation.number : index + 1;
}

// Each panel/list owns its completions. A late read or mutation cannot reclaim
// a closed panel, another scope, or a newer selection.
export function createGroundingRequests({ isConnected = () => true } = {}) {
    const owner = createLifecycleOwner();
    let controller = new AbortController();
    return {
        capture: () => owner.capture(),
        current: lease => isConnected() && owner.current(lease),
        signal: () => controller.signal,
        advance() { controller.abort(); controller = new AbortController(); owner.advance(); },
        dispose() { controller.abort(); owner.dispose(); },
    };
}

export function factCandidateBody(source, values) {
    const identity = sourceIdentity(source);
    if (!identity || !Number.isInteger(source.version)) throw new Error('请先重新读取来源版本。');
    const result = { sourceType: identity.type, sourceId: identity.sourceId, sourceVersion: source.version,
        entity: String(values.entity || '').trim(), field: String(values.field || '').trim(),
        value: String(values.value || '').trim(), unit: String(values.unit || '').trim(),
        aliases: [...new Set(String(values.aliases || '').split(/[,，\n]/).map(value => value.trim()).filter(Boolean))],
        evidence: String(values.evidence || '').trim() };
    if (values.conditions) result.conditions = String(values.conditions).trim();
    if (values.validFrom) result.validFrom = String(values.validFrom);
    if (values.validUntil) result.validUntil = String(values.validUntil);
    if (!result.entity || !result.field || !result.value || !result.evidence) throw new Error('请填写对象、字段、原始值和来源摘录。');
    if (values.evidenceChunkId) result.evidenceChunkId = values.evidenceChunkId;
    return result;
}

export function factPeriodLabel(fact, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })) {
    if (fact.validUntil && fact.validUntil < today) return '有效期已过';
    if (fact.validFrom && fact.validFrom > today) return '尚未生效';
    return fact.validFrom ? '有效期 ' + fact.validFrom + ' 至 ' + fact.validUntil : '';
}
