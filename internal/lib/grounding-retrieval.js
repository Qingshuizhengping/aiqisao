import { requireReadyEmployee, requireProjectContext } from './access.js';
import { fail } from './errors.js';
import { controlRevision, normalized, readVector, sensitive, vectorBuffer } from './memory-store.js';
import { normalizeNumerals, factApplies, queryDateRange, conditionsMatched } from './grounding-values.js';
import { createKnowledgeEmbedding } from './knowledge-jobs.js';

const FIELD_GROUPS = [
    ['价格', '售价', '单价', '多少钱', '价钱', '定价', '费用', '报价', '收费'],
    ['用量', '剂量', '使用量', '用多少', '每次用量'],
    ['规格', '包装规格'],
    ['容量', '容积', '体积'],
    ['净含量', '净重'],
    ['型号', '产品型号'],
    ['成分', '配方'],
    ['适用人群', '适用对象', '人群'],
    ['功效', '作用', '效果'],
    ['使用方法', '怎么使用', '如何使用', '怎么用', '用法', '使用步骤'],
    ['制度', '规定', '规则', '要求'],
];
const TEXT_GROUPS = new Set([FIELD_GROUPS.at(-1), FIELD_GROUPS.at(-2)]);
const NUMERIC_FIELDS = ['参数', '浓度', '待付款', '已付款', '数量', '库存', '余额', '总额', '总价', '保质期', '有效期', '疗程', '天数', '次数', '频次', '使用频率', '折扣', '税率', '成本'];
const NOISE = /请问|帮我|告诉我|查询|查一下|一下|现在|目前|最新|到底|是什么|是多少|有哪些|如何|怎么|是否|能否|的|了|吗|呢/gu;
const PRICE_QUALIFIERS = ['批发', '零售', '会员', '加盟', '促销', '成本', '进货', '原价', '活动', '渠道'];
const valueIdentity = value => String(value ?? '').normalize('NFKC').trim();

function specifications(text) {
    const units = { ml: 'ml', 毫升: 'ml', l: 'l', 升: 'l', kg: 'kg', 千克: 'kg', mg: 'mg', 毫克: 'mg', g: 'g', 克: 'g', '%': '%' };
    const result = [];
    for (const match of normalizeNumerals(text).toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(毫升|毫克|千克|ml|kg|mg|g|l|升|克|%|(?:瓶|支|袋|盒|片|粒)(?=装))/g)) {
        const value = match[1].replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        result.push({ key: value + ':' + (units[match[2]] || match[2]), label: value + match[2] });
    }
    return result;
}
function years(text) {
    return [...normalizeNumerals(text).matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/g)].map(match => match[1]);
}
function constraintsFor(query, now) {
    query = normalizeNumerals(query);
    const constraints = specifications(query).map(item => ({ kind: 'specification', key: item.key, label: item.label }));
    for (const year of years(query)) constraints.push({ kind: 'year', key: year, label: year + '年' });
    const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date(now)));
    if (/今年|本年度/.test(query)) constraints.push({ kind: 'year', key: String(currentYear), label: String(currentYear) + '年' });
    if (/去年/.test(query)) constraints.push({ kind: 'year', key: String(currentYear - 1), label: String(currentYear - 1) + '年' });
    if (/前年/.test(query)) constraints.push({ kind: 'year', key: String(currentYear - 2), label: String(currentYear - 2) + '年' });
    for (const label of ['旧版', '老版', '历史', '以前', '之前', '原来', '过去', '上个月', '上月', '上周', '昨天']) {
        if (query.includes(label)) constraints.push({ kind: 'label', key: normalized(label), label });
    }
    return constraints;
}
function hasConstraint(text, constraint) {
    if (constraint.kind === 'specification') return specifications(text).some(item => item.key === constraint.key);
    if (constraint.kind === 'year') return years(text).includes(constraint.key);
    return normalized(text).includes(constraint.key);
}
function exactValue(text, value) {
    const body = valueIdentity(text), token = valueIdentity(value);
    if (!/\d/.test(token)) return body.includes(token);
    let offset = body.indexOf(token);
    while (offset !== -1) {
        if (!/[\d.]/.test(body[offset - 1] || '') && !/[\d.]/.test(body[offset + token.length] || '')) return true;
        offset = body.indexOf(token, offset + 1);
    }
    return false;
}
function supportsConstraint(fact, constraint) {
    if ([fact.entity, fact.field, ...(fact.aliases || [])].some(text => hasConstraint(text, constraint))) return true;
    // A broad quote containing several rows/versions is not enough: the
    // qualifier, exact value and named object must agree in the same clause.
    return String(fact.evidence || '').split(/[\n\r。；;，,]/).some(clause => hasConstraint(clause, constraint)
        && exactValue(clause, fact.value)
        && [fact.entity, ...(fact.aliases || [])].some(name => normalized(clause).includes(normalized(name))));
}

function terms(query, expanded = false) {
    const text = String(query).normalize('NFKC').toLowerCase().replace(NOISE, ' ');
    const result = new Set(text.match(/[a-z\d][a-z\d_.-]*|[\u3400-\u9fff]+/g) || []);
    for (const word of [...result]) {
        if (!/^[\u3400-\u9fff]+$/.test(word)) continue;
        for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2));
        for (let index = 0; index < word.length - 2; index++) result.add(word.slice(index, index + 3));
    }
    if (expanded) for (const group of FIELD_GROUPS) {
        if (group.some(word => normalized(query).includes(normalized(word)))) group.forEach(word => result.add(word));
    }
    return [...result].map(normalized).filter(word => word.length >= 2).slice(0, 160);
}

function fieldMatches(query, field) {
    const question = normalized(query), name = normalized(field);
    if (name && question.includes(name)) return true;
    if (FIELD_GROUPS[0].some(word => question.includes(normalized(word)))
        && PRICE_QUALIFIERS.some(word => name.includes(word)) && /价|费/.test(name)) return true;
    return FIELD_GROUPS.some(group => group.some(word => normalized(word) === name)
        && group.some(word => question.includes(normalized(word))));
}

function matchFacts(facts, query, now = Date.now()) {
    const question = normalized(query);
    const requestedFields = FIELD_GROUPS.filter(group => group.some(word => question.includes(normalized(word))));
    const priceQualifiers = /价|费|多少钱/.test(query) ? PRICE_QUALIFIERS.filter(word => question.includes(normalized(word))) : [];
    const numericFields = NUMERIC_FIELDS.filter(field => question.includes(normalized(field)));
    const broadParameters = /(?:产品)?参数/.test(query);
    const constraints = constraintsFor(query, now);
    const requiresFacts = requestedFields.some(group => !TEXT_GROUPS.has(group)) || numericFields.length > 0 || priceQualifiers.length > 0 || constraints.length > 0;
    const entityAliases = new Map();
    for (const fact of facts) for (const name of [fact.entity, ...(fact.aliases || [])]) {
        const alias = normalized(name);
        if (!alias || !question.includes(alias)) continue;
        const entities = entityAliases.get(alias) || new Set();
        entities.add(normalized(fact.entity)); entityAliases.set(alias, entities);
    }
    const mentions = [...entityAliases.keys()].flatMap(alias => {
        const found = [];
        let index = question.indexOf(alias);
        while (index !== -1) { found.push({ alias, start: index, end: index + alias.length }); index = question.indexOf(alias, index + 1); }
        return found;
    });
    const specificAliases = new Set(mentions.filter(mention => !mentions.some(other => other.alias.length > mention.alias.length
        && other.start <= mention.start && other.end >= mention.end)).map(mention => mention.alias));
    const activeAliases = [...entityAliases].filter(([alias]) => specificAliases.has(alias));
    const entities = new Set(activeAliases.flatMap(([, names]) => [...names]));
    let residue = question;
    for (const [alias] of activeAliases.sort((a,b) => b[0].length-a[0].length)) residue = residue.split(alias).join('');
    const overview = /介绍|概览|总览|基本信息|参数|资料|信息/.test(question) || !residue.replace(NOISE,'').replace(/[?？。!！，,\s]/g,'');
    const relevant = facts.filter(fact => !entities.size || entities.has(normalized(fact.entity)));
    const filtered = relevant.filter(fact => {
        const qualifiedPrice = priceQualifiers.some(word => normalized(fact.field).includes(normalized(word)));
        const otherRequested = requestedFields.filter(group => group !== FIELD_GROUPS[0]).some(group => fieldMatches(group[0], fact.field))
            || numericFields.some(field => normalized(fact.field).includes(normalized(field)));
        if (priceQualifiers.length && !qualifiedPrice && !otherRequested) return false;
        if (constraints.some(constraint => !supportsConstraint(fact, constraint))) return false;
        if (!factApplies(fact, query, now)) return false;
        if (priceQualifiers.length) return qualifiedPrice || otherRequested;
        if (broadParameters) return entities.size > 0 || fieldMatches(query, fact.field);
        if (requestedFields.length) return fieldMatches(query, fact.field);
        if (numericFields.length) return numericFields.some(field => normalized(fact.field).includes(normalized(field)));
        return overview && entities.size > 0 || fieldMatches(query, fact.field);
    });
    const neededGroups = requestedFields.filter(group => (requiresFacts || !TEXT_GROUPS.has(group)) && (!priceQualifiers.length || group !== FIELD_GROUPS[0]));
    const targets = entities.size ? [...entities] : [null];
    const missingFields = [];
    for (const target of targets) {
        const available = filtered.filter(fact => !target || normalized(fact.entity) === target);
        const label = relevant.find(fact => normalized(fact.entity) === target)?.entity;
        const addMissing = field => missingFields.push((label ? label + '：' : '') + field);
        for (const word of priceQualifiers) if (!available.some(fact => normalized(fact.field).includes(normalized(word)))) addMissing(word.endsWith('价') ? word : word + '价');
        for (const group of neededGroups) if (!available.some(fact => fieldMatches(group[0], fact.field))) addMissing(group[0]);
        if (!priceQualifiers.length && requestedFields.includes(FIELD_GROUPS[0])
            && available.some(fact => /价|费/.test(fact.field) && PRICE_QUALIFIERS.some(word => fact.field.includes(word)))) addMissing('请明确价格类型（如零售或批发）');
        if (!broadParameters) for (const field of numericFields) if (!available.some(fact => normalized(fact.field).includes(normalized(field)))) addMissing(field);
        if (broadParameters && !available.length) addMissing('参数');
        if (requiresFacts && relevant.some(fact => !target || normalized(fact.entity) === target) && !available.length
            && relevant.some(fact => (!target || normalized(fact.entity) === target) && !factApplies(fact, query, now))) {
            addMissing(queryDateRange(query, now).label + '及适用条件对应的事实');
        }
    }
    if (constraints.length && !filtered.length) missingFields.push(...constraints.map(constraint => constraint.label + '对应的事实'));
    const conflicts = [];
    const groups = new Map();
    for (const fact of filtered) {
        const key = normalized(fact.entity) + '\u0000' + normalized(fact.field);
        const group = groups.get(key) || []; group.push(fact); groups.set(key, group);
    }
    for (const group of groups.values()) {
        if (new Set(group.map(fact => JSON.stringify([valueIdentity(fact.value), valueIdentity(fact.unit)]))).size > 1) {
            conflicts.push({ type: 'conflicting_values', entity: group[0].entity, field: group[0].field,
                factIds: group.map(fact => fact.id) });
        }
    }
    const ambiguousAliases = activeAliases.filter(([, names]) => names.size > 1 && ![...names].every(name => question.includes(name)));
    const ambiguous = filtered.length > 0 && (!entities.size || ambiguousAliases.length > 0);
    if (ambiguous) conflicts.push({ type: 'ambiguous_entity', entities: [...new Set(filtered.map(fact => fact.entity))],
        factIds: filtered.map(fact => fact.id) });
    return { facts: filtered, conflicts, ambiguous, explicitEntity: entities.size > 0, missingFields: [...new Set(missingFields)], requiresFacts };
}

// Ranking gates decide what to inspect. They are not confidence estimates and
// never replace source confirmation, claim verification or final authorization.
export function createGroundingRetrieval({ db, config = {}, provider, library }) {
    const model = String(config.embeddingModel || 'BAAI/bge-m3');
    const embed = createKnowledgeEmbedding({ config, provider });
    const maximumCharacters = Math.min(40000, Math.max(1200, config.groundingContextCharacters || 16000));
    const maximumEvidence = Math.min(32, Math.max(4, config.groundingEvidenceLimit || 16));
    const chunksForFile = db.prepare('SELECT * FROM knowledge_chunks WHERE file_id=? AND file_version=? ORDER BY chunk_index');
    const memoryVector = db.prepare('SELECT embedding,embedding_model,embedding_dimension FROM memories WHERE id=? AND version=?');

    function authorize(user, projectId) {
        requireReadyEmployee(db, user);
        if (projectId) requireProjectContext(db, user, projectId);
    }
    function controls(user, projectId) {
        return [controlRevision(db, 'user:' + user.id), projectId ? controlRevision(db, 'membership:' + user.id + ':' + projectId) : 0,
            projectId ? controlRevision(db, 'project:' + projectId) : 0].join(':');
    }
    function candidates(sources) {
        const result = [];
        for (const source of sources) {
            const common = { sourceType: source.type || source.sourceType, sourceId: source.sourceId, version: source.version,
                confirmationId: source.confirmationId, scope: source.scope, userId: source.userId,
                projectId: source.projectId || null, title: source.title || '资料' };
            if (common.sourceType === 'memory') {
                result.push({ evidence: { ...common, id: 'memory:' + source.sourceId, content: source.content },
                    index: memoryVector.get(source.sourceId, source.version) || {} });
            } else if (common.sourceType === 'file') {
                // Every authorized file/version is inspected; there is no global
                // newest-N cutoff that can make older confirmed sources vanish.
                for (const chunk of chunksForFile.iterate(source.sourceId, source.version)) result.push({
                    evidence: { ...common, id: 'file:' + chunk.id, content: chunk.content,
                        chunkId: chunk.id, chunkIndex: chunk.chunk_index }, index: chunk,
                });
            }
        }
        return result;
    }
    function rank(rows, query, words, vector, facts) {
        const question = normalized(query);
        return rows.map(row => {
            const body = normalized(row.evidence.content), title = normalized(row.evidence.title);
            const lexical = words.length ? words.filter(word => body.includes(word) || title.includes(word)).length / words.length : 0;
            const exactTitle = title.length > 1 && question.includes(title);
            const factSupport = facts.some(fact => fact.sourceType === row.evidence.sourceType && fact.sourceId === row.evidence.sourceId
                && (fact.evidenceChunkId ? fact.evidenceChunkId === row.evidence.chunkId : row.evidence.content.includes(fact.evidence)));
            const indexed = vector && row.index.embedding_model === model && row.index.embedding_dimension === vector.length
                ? readVector(row.index.embedding, row.index.embedding_dimension) : null;
            const semantic = indexed ? Math.max(0, indexed.reduce((score, value, index) => score + value * vector[index], 0)) : 0;
            return { ...row, lexical, exactTitle, factSupport, semantic,
                score: (factSupport ? 4 : 0) + (exactTitle ? 2 : 0) + lexical * 0.7 + semantic * 0.3 };
        }).sort((first, second) => second.score - first.score || first.evidence.id.localeCompare(second.evidence.id));
    }
    function choose(ranked, allRows, expanded) {
        const selected = [], seen = new Set();
        let characters = 0;
        const add = row => {
            if (!row || seen.has(row.evidence.id) || selected.length >= maximumEvidence
                || characters + row.evidence.content.length > maximumCharacters) return false;
            selected.push(row.evidence); seen.add(row.evidence.id); characters += row.evidence.content.length;
            return true;
        };
        const fileRows = new Map();
        for (const row of allRows) if (row.evidence.sourceType === 'file') {
            const group = fileRows.get(row.evidence.sourceId) || new Map();
            group.set(row.evidence.chunkIndex, row); fileRows.set(row.evidence.sourceId, group);
        }
        // Facts and exact names precede broad semantic candidates. Reserve room
        // for context without allowing neighbors to evict the primary evidence.
        for (const row of ranked) {
            if (selected.length >= Math.min(10, maximumEvidence)) break;
            add(row);
        }
        for (const evidence of [...selected]) if (evidence.sourceType === 'file') {
            const group = fileRows.get(evidence.sourceId);
            const first = group?.get(0);
            if (evidence.chunkIndex > 0 && first && /\t|\|/.test(first.evidence.content)) add(first);
            if (expanded || /\t|\|/.test(evidence.content)) {
                add(group?.get(evidence.chunkIndex - 1)); add(group?.get(evidence.chunkIndex + 1));
            }
        }
        return selected;
    }
    async function retrieve({ user, projectId = null, query, signal } = {}) {
        signal?.throwIfAborted();
        if (typeof query !== 'string' || !query.trim()) return { evidence: [], facts: [], degraded: false, expanded: false, conflicts: [], ambiguous: false, requiresFacts: false, missingFields: [] };
        if (query.length > 16000) fail(400, 'GROUNDING_QUERY_TOO_LONG', '查询内容过长，请缩短后重试。');
        const requirements = matchFacts([], query, config.groundingNow ?? Date.now());
        const empty = extra => ({ evidence: [], facts: [], degraded: false, expanded: false, conflicts: [], ambiguous: false,
            requiresFacts: requirements.requiresFacts, missingFields: requirements.missingFields, ...extra });
        authorize(user, projectId);
        if (sensitive(query)) return empty({ degraded: true, code: 'GROUNDING_SENSITIVE_QUERY' });
        try {
            const catalog = library.catalog({ user, projectId });
            const originalStamp = controls(user, projectId);
            const rows = candidates(catalog.sources);
            const matchedFacts = matchFacts(catalog.facts, query, config.groundingNow ?? Date.now());
            if (!rows.length && !matchedFacts.facts.length) return empty();
            let vector = null, degraded = false;
            try {
                const vectors = await embed([query.slice(0, 8000)], signal);
                if (!Array.isArray(vectors) || vectors.length !== 1) throw new Error('Invalid query embedding');
                vector = readVector(vectorBuffer(vectors[0]), vectors[0].length);
            } catch (error) {
                if (signal?.aborted) throw signal.reason || error;
                degraded = true;
            }
            signal?.throwIfAborted(); authorize(user, projectId);
            if (controls(user, projectId) !== originalStamp) return empty({ degraded: true, code: 'GROUNDING_ACCESS_CHANGED' });
            let ranked = rank(rows, query, terms(query), vector, matchedFacts.facts)
                .filter(row => row.factSupport || row.exactTitle || row.lexical >= 0.18 || row.semantic >= 0.48);
            const expanded = !ranked.some(row => row.factSupport || row.exactTitle || row.lexical >= 0.18);
            if (expanded) ranked = rank(rows, query, terms(query, true), vector, matchedFacts.facts)
                .filter(row => row.factSupport || row.exactTitle || row.lexical >= 0.04 || row.semantic >= 0.28);
            const selected = choose(ranked, rows, expanded);
            const fresh = library.revalidate({ user, projectId, evidence: selected, facts: matchedFacts.facts });
            if (fresh.evidence.length !== selected.length || fresh.facts.length !== matchedFacts.facts.length) degraded = true;
            // Recompute conflicts only from the current confirmed records, never
            // from rows that were revoked while embedding the question.
            const finalFacts = matchFacts(fresh.facts, query, config.groundingNow ?? Date.now());
            return { evidence: fresh.evidence, facts: finalFacts.facts, degraded, expanded,
                conflicts: finalFacts.conflicts, ambiguous: finalFacts.ambiguous,
                unresolvedConditions: finalFacts.facts.filter(fact => !conditionsMatched(fact, query)).map(fact => ({ id: fact.id, entity: fact.entity, conditions: fact.conditions })),
                missingFields: [...new Set([...matchedFacts.missingFields, ...finalFacts.missingFields])], requiresFacts: finalFacts.requiresFacts,
                ...(degraded ? { code: 'GROUNDING_RETRIEVAL_UNAVAILABLE' } : {}) };
        } catch (error) {
            if (signal?.aborted || [400, 401, 403, 428].includes(error?.status)) throw error;
            return empty({ degraded: true, code: 'GROUNDING_RETRIEVAL_UNAVAILABLE' });
        }
    }
    return { retrieve };
}
