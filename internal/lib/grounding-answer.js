import { sensitive } from './memory-store.js';
import { numbersPreserved } from './grounding-values.js';

const HARD_FIELDS = /价格|多少钱|价钱|价位|几块|几元|售价|单价|批发价|零售价|收费|费用|报价|用量|剂量|参数|规格|浓度|疗程|成分|有效期|保质期/;
const POLICY = /制度|规定|政策|条款|规则|必须|禁止|应当|不得/;
const IMPORTANT = new RegExp(HARD_FIELDS.source + '|' + POLICY.source);
const PRICE = /价格|多少钱|价钱|几块|几元|售价|单价|费用|收费|报价/;
const NUMBER = /\p{N}|[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億貳參兩]{2,}|[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億貳參兩]+\s*(?:元|圆|圓|块|塊|天|日|次|瓶|支|盒|件|个|毫|克|升|米|度|岁|年|月|小时|分钟|%|％)/u;
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const escape = value => String(value || '').replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&');
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const identity = item => JSON.stringify([item.id, item.version, item.confirmationId || item.sourceConfirmationId || null]);
const unitText = fact => fact.unit && !String(fact.value).endsWith(fact.unit) ? fact.unit : '';
const factText = fact => `${fact.entity} · ${fact.field}：${fact.value}${unitText(fact)}`
    + (fact.validFrom ? `（有效期：${fact.validFrom} 至 ${fact.validUntil}）` : '')
    + (fact.conditions ? `\n适用条件原文：${fact.conditions}` : '');

function decimal(value) {
    const match = /^(\d{1,18})(?:\.(\d{1,6}))?$/.exec(String(value));
    if (!match) return null;
    const scale = (match[2] || '').length;
    return { integer: BigInt(match[1] + (match[2] || '')), scale };
}

export function multiplyExact(value, quantity) {
    const a = decimal(value), b = decimal(quantity);
    if (!a || !b || Number(quantity) > 1000000) return null;
    const scale = a.scale + b.scale;
    const raw = (a.integer * b.integer).toString().padStart(scale + 1, '0');
    return scale ? (raw.slice(0, -scale) + '.' + raw.slice(-scale)).replace(/\.?0+$/, '') || '0' : raw;
}

function citationForFact(fact) {
    return { id: 'fact:' + fact.id, factId: fact.id, factVersion: fact.version,
        sourceType: fact.sourceType, sourceId: fact.sourceId, version: fact.sourceVersion,
        scope: fact.scope, projectId: fact.projectId, title: fact.entity + ' · ' + fact.field,
        quote: fact.evidence, chunkId: fact.evidenceChunkId || undefined };
}

function citationForEvidence(entry, quote) {
    return { id: entry.id, sourceType: entry.sourceType, sourceId: entry.sourceId, version: entry.version,
        scope: entry.scope, projectId: entry.projectId, title: entry.title,
        chunkId: entry.chunkId, chunkIndex: entry.chunkIndex, quote };
}

function calculation(query, facts) {
    if (!PRICE.test(query) || !facts.every(fact => /价|费|金额/.test(fact.field))) return null;
    if (facts.length >= 2 && facts.length <= 12 && new Set(facts.map(fact => fact.unit)).size === 1
        && /^(?:元|人民币元|¥|￥)(?:\/(?:瓶|支|盒|件|套|个|份)|每(?:瓶|支|盒|件|套|个|份))?$/.test(facts[0].unit)) {
        const numbers = facts.map(fact => decimal(fact.value));
        const difference = facts.length === 2 && /差价|价差|相差|差多少|贵多少|便宜多少/.test(query);
        const sum = /价格之和|单价合计|金额之和/.test(query);
        if (numbers.every(Boolean) && (difference || sum)) {
            const scale = Math.max(...numbers.map(value => value.scale));
            const integers = numbers.map(value => value.integer * 10n ** BigInt(scale - value.scale));
            let integer = difference ? integers[0] - integers[1] : integers.reduce((a, b) => a + b, 0n);
            if (integer < 0n) integer = -integer;
            const raw = integer.toString().padStart(scale + 1, '0');
            const value = scale ? (raw.slice(0, -scale) + '.' + raw.slice(-scale)).replace(/\.?0+$/, '') || '0' : raw;
            return { text: `${difference ? '已确认单价的差额' : '已确认单价之和'}：${value}${facts[0].unit}。`,
                factId: facts[0].id, factIds: facts.map(fact => fact.id), operation: difference ? 'absolute_difference' : 'sum', value, unit: facts[0].unit };
        }
    }
    if (facts.length !== 1) return null;
    let quantityQuery = query;
    for (const name of [facts[0].entity, ...(facts[0].aliases || [])].sort((a, b) => b.length - a.length)) {
        const token = normalize(name); if (token) quantityQuery = quantityQuery.split(token).join('');
    }
    quantityQuery = quantityQuery.split(normalize(facts[0].field)).join('');
    if (/[×÷*^=<>±−﹣－⁻＋√≥≤]/.test(quantityQuery) || /大约|约|左右|上下|至少|最多|不少于|不超过|大于|小于|多于|少于/.test(quantityQuery)) return null;
    const amounts = [...quantityQuery.matchAll(/(?<![A-Za-z0-9_.,，+\-])(\d+(?:\.\d{1,6})?)\s*(瓶|支|盒|件|套|个|份)/g)];
    if (amounts.length !== 1) return null;
    const remainder = quantityQuery.replace(amounts[0][0], '').replace(/一共/g, '');
    if (/\p{N}|[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億貳參兩]/u.test(remainder)) return null;
    const unrecognized = remainder.replace(/购买|买|需要|我要|想要|合计|总价|总共|是多少钱|多少钱|价格|单价|价钱|售价|的|请问|计算|算下|算|帮我|一下|[?？!！。，,：:；;\s]/g, '');
    if (unrecognized) return null;
    const [ , amount, itemUnit ] = amounts[0];
    const fact = facts[0];
    const unit = /^(元|人民币元|¥|￥)(?:\/(瓶|支|盒|件|套|个|份)|每(瓶|支|盒|件|套|个|份))$/.exec(fact.unit);
    if (!unit || (unit[2] || unit[3]) !== itemUnit) return null;
    const value = multiplyExact(fact.value, amount);
    return value === null ? null : { text: `${amount}${itemUnit}合计：${value}${unit[1]}。`, factId: fact.id, factIds: [fact.id],
        operation: 'multiply', quantity: amount, value, unit: unit[1] };
}

export function createGroundedAnswerService({ db, provider, library, retrieval }) {
    function isCurrent({ user, projectId, evidence, facts }) {
        try {
            const fresh = library.revalidate({ user, projectId, evidence, facts });
            const a = fresh.evidence.map(identity).sort(), b = evidence.map(identity).sort();
            const c = fresh.facts.map(identity).sort(), d = facts.map(identity).sort();
            return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(c) === JSON.stringify(d);
        } catch { return false; }
    }

    function result(status, text, { user, projectId, evidence = [], facts = [], citations = [], claims = [], expanded = false, basis = 'confirmed_sources', computations = [] } = {}) {
        const numbered = citations.map((entry, index) => ({ ...entry, number: index + 1 }));
        return { text, grounding: { stage: 'complete', status, citations: numbered, claims, expanded, basis, computations },
            check: () => isCurrent({ user, projectId, evidence, facts }) };
    }

    const unavailable = parameters => result('unavailable', '暂时无法核实资料，当前不提供确定的事实回答。请稍后重试，或在记忆库检查资料确认与索引状态。', parameters);
    const insufficient = parameters => result('insufficient', '当前授权范围内没有找到足够的已确认依据，暂时无法确认。请补充相关资料，并在记忆库的“事实与确认”中完成确认。', parameters);

    function completeQuote(user, entry, text) {
        const content = typeof library.source === 'function'
            ? library.source({ user, type: entry.sourceType, id: entry.sourceId, version: entry.version }).content : entry.content;
        return content.trim() === text.trim() || content.split(/\n\s*\n/).some(paragraph => paragraph.trim() === text.trim());
    }

    function preference(user) {
        if (!db) return {};
        const rows = db.prepare("SELECT content FROM memories WHERE user_id=? AND scope='personal' AND status='active'").all(user.id);
        const texts = rows.map(row => row.content).filter(content => !IMPORTANT.test(content) && !NUMBER.test(content));
        return { concise: texts.some(text => /偏好|喜欢|希望/.test(text) && /简洁|简短|精简/.test(text)),
            conclusionFirst: texts.some(text => /先.*结论|结论.*优先/.test(text)) };
    }

    async function answer({ user, projectId = null, query, signal, onProgress = () => {} }) {
        signal?.throwIfAborted();
        const base = { user, projectId };
        const question = normalize(query);
        if (sensitive(query)) return unavailable(base);
        if (/^(?:你好|您好|嗨|hello|hi|谢谢|感谢|早上好|下午好|晚上好)[！!。,.，\s]*$/i.test(query.trim())) {
            return result('verified', /谢|感谢/.test(query) ? '不客气。需要查询资料时，我会先核对依据。' : '你好，我是AI七嫂·员工专属版。可以帮你查询已确认资料、整理工作问题。', { ...base, basis: 'conversation' });
        }
        const rewriteSeparator = /[:：\n“「]/.exec(query);
        const rewriting = /(?:润色|改写|翻译|校对|整理(?:下面|以下|这段))/.test(question) && Boolean(rewriteSeparator);
        const rewriteInput = rewriting ? query.slice(rewriteSeparator.index + 1).trim().replace(/[”」]$/, '') : '';
        onProgress({ stage: 'retrieving', status: 'pending', citations: [] });
        let found;
        try { found = rewriting ? { evidence: [], facts: [], degraded: false } : await retrieval.retrieve({ user, projectId, query, signal }); }
        catch (error) { if (signal?.aborted) throw error; return unavailable(base); }
        signal?.throwIfAborted();
        let evidence = found.evidence || [], facts = found.facts || [];
        if (found.degraded || !isCurrent({ ...base, evidence, facts })) return unavailable(base);
        if (found.ambiguous || found.conflicts?.some(entry => entry.type === 'ambiguous_entity')) {
            const names = [...new Set(facts.map(fact => fact.entity))].slice(0, 8);
            return result('insufficient', '当前问题可能对应多个对象，请明确要查询的对象' + (names.length ? '：' + names.map(escape).join('、') : '') + '。', { ...base, evidence, facts });
        }
        // The retrieval module owns field/entity matching, including multi-field
        // queries and unresolved qualifiers. Do not apply a second, weaker match.
        const related = facts;
        const missingFields = Array.isArray(found.missingFields) ? found.missingFields : [];
        const groups = new Map();
        for (const fact of related) {
            const key = normalize(fact.entity) + ':' + normalize(fact.field);
            groups.set(key, [...(groups.get(key) || []), fact]);
        }
        const conflicted = [...groups.values()].filter(group => new Set(group.map(fact => normalize(fact.value) + ':' + normalize(fact.unit))).size > 1).flat();
        if (conflicted.length || found.conflicts?.some(entry => entry.type === 'conflicting_values')) {
            const conflictingIds = new Set((found.conflicts || []).flatMap(entry => entry.type === 'conflicting_values' ? entry.factIds || [] : []));
            const candidates = conflicted.length ? conflicted : facts.filter(fact => conflictingIds.has(fact.id));
            const citations = candidates.map(citationForFact);
            return result('conflict', '发现不同值或适用条件的资料记录，暂不选择其中一个值：\n\n' + candidates.map((fact, index) => `- ${escape(factText(fact))} [${index + 1}]`).join('\n') + '\n\n请先明确适用条件，或由有权限的人员确认有效版本。', { ...base, evidence, facts, citations, expanded: found.expanded });
        }
        if (HARD_FIELDS.test(question) || found.requiresFacts || missingFields.length) {
            if (!related.length) return result('insufficient', '当前没有足够的已确认依据，暂时无法确认。'
                + (missingFields.length ? '\n\n待确认：' + missingFields.map(escape).join('、') + '。' : '\n请在记忆库确认来源与标准事实。'), { ...base, evidence, facts, expanded: found.expanded });
            const unique = [...new Map(related.map(fact => [normalize(fact.entity) + ':' + normalize(fact.field), fact])).values()];
            if (unique.length > 24) return insufficient({ ...base, evidence, facts });
            const conditional = (found.unresolvedConditions || []).length > 0;
            const computed = conditional || missingFields.length ? null : calculation(question, unique);
            const mathRequested = PRICE.test(question) && (/合计|总价|总共|一共|价格之和|差价|价差|相差|差多少|贵多少|便宜多少/.test(question)
                || /[\p{N}零〇一二三四五六七八九十百千万亿两]+(?:瓶|支|盒|件|套|个|份)/u.test(question));
            const citations = unique.map(citationForFact);
            let text = unique.map((fact, index) => `- ${escape(factText(fact))} [${index + 1}]`).join('\n');
            if (computed) text += '\n\n' + escape(computed.text) + computed.factIds.map(id => ` [${unique.findIndex(fact => fact.id === id) + 1}]`).join('');
            else if (mathRequested) text += '\n\n数量、对象或计价单位尚不能唯一对应，当前只列已确认原值，暂不计算。';
            onProgress({ stage: 'verifying', status: 'pending', citations: [] });
            if (!isCurrent({ ...base, evidence, facts })) return unavailable(base);
            if (missingFields.length) text += '\n\n以下内容尚无足够的已确认依据，暂时无法确认：' + missingFields.map(escape).join('、') + '。';
            if (conditional) text = '以下仅为原文条件成立时的标准记录，尚未确认当前请求是否满足条件：\n\n' + text + '\n\n请先确认上述适用条件，当前不计算最终报价。';
            return result(conditional || missingFields.length || mathRequested && !computed ? 'partial' : 'verified', text, { ...base, evidence, facts, citations, expanded: found.expanded,
                claims: unique.map((fact, index) => ({ id: 'fact-' + index, citationIds: ['fact:' + fact.id] })), computations: computed ? [computed] : [] });
        }
        if (!evidence.length && !rewriting) return insufficient({ ...base, evidence, facts });
        const inputEvidence = rewriting ? [{ id: 'user-input', content: rewriteInput, title: '本轮用户输入', sourceType: 'input' }] : evidence;
        onProgress({ stage: 'drafting', status: 'pending', citations: [] });
        try {
            const draft = await provider.draftGrounded({ question: query, evidence: inputEvidence, facts, style: preference(user) }, { signal });
            signal?.throwIfAborted();
            if (!isCurrent({ ...base, evidence, facts })) return unavailable(base);
            if (!only(draft, ['claims']) || !Array.isArray(draft.claims) || draft.claims.length > 12) return unavailable(base);
            const ids = new Set(), valid = [], byEvidence = new Map(inputEvidence.map(item => [item.id, item])), byFacts = new Map(facts.map(item => [item.id, item]));
            for (const claim of draft.claims) {
                if (!only(claim, ['id', 'kind', 'text', 'evidenceIds', 'quote', 'factId']) || typeof claim.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(claim.id)
                    || ids.has(claim.id) || !['summary', 'quote', 'fact'].includes(claim.kind) || typeof claim.text !== 'string' || claim.text.length > 1200) return unavailable(base);
                ids.add(claim.id);
                if (claim.kind === 'fact') {
                    const fact = byFacts.get(claim.factId);
                    if (fact) valid.push({ ...claim, text: factText(fact), fact });
                    continue;
                }
                if (!Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length || claim.evidenceIds.length > 3 || claim.evidenceIds.some(id => !byEvidence.has(id))
                    || typeof claim.quote !== 'string' || !claim.quote.trim() || claim.quote.length > 1200
                    || !claim.evidenceIds.some(id => byEvidence.get(id).content.includes(claim.quote))) continue;
                if (claim.kind === 'quote' && !claim.evidenceIds.some(id => byEvidence.get(id).content.includes(claim.text))) continue;
                if (!claim.text.trim() || sensitive(claim.text)) continue;
                const normalizedClaim = normalize(claim.text);
                if (!rewriting && (NUMBER.test(claim.text) || NUMBER.test(normalizedClaim) || IMPORTANT.test(normalizedClaim) || POLICY.test(question))) {
                    if (claim.kind !== 'quote' || !claim.evidenceIds.some(id => completeQuote(user, byEvidence.get(id), claim.text))) continue;
                }
                if (rewriting) {
                    if (!numbersPreserved(rewriteInput, claim.text)) continue;
                }
                valid.push(claim);
            }
            if (!valid.length) return insufficient({ ...base, evidence, facts });
            onProgress({ stage: 'verifying', status: 'pending', citations: [] });
            const checked = await provider.verifyGrounded({ question: query, evidence: inputEvidence, facts,
                claims: valid.map(({ fact, ...claim }) => claim), mode: rewriting ? 'rewrite_without_new_facts' : 'facts_only' }, { signal });
            signal?.throwIfAborted();
            if (!isCurrent({ ...base, evidence, facts })) return unavailable(base);
            if (!only(checked, ['verdicts']) || !Array.isArray(checked.verdicts) || checked.verdicts.length !== valid.length) return unavailable(base);
            const verdicts = new Map();
            for (const value of checked.verdicts) {
                if (!only(value, ['claimId', 'supported', 'relevant']) || !valid.some(claim => claim.id === value.claimId) || verdicts.has(value.claimId)
                    || typeof value.supported !== 'boolean' || typeof value.relevant !== 'boolean') return unavailable(base);
                verdicts.set(value.claimId, value);
            }
            const supported = valid.filter(claim => verdicts.get(claim.id)?.supported && verdicts.get(claim.id)?.relevant);
            if (!supported.length) return insufficient({ ...base, evidence, facts });
            const citations = [], claims = [], lines = [];
            for (const claim of supported) {
                const references = rewriting ? [] : claim.fact ? [citationForFact(claim.fact)] : claim.evidenceIds.map(id => {
                    const item = byEvidence.get(id);
                    return citationForEvidence(item, item.content.includes(claim.quote) ? claim.quote : '');
                });
                const numbers = references.map(reference => {
                    let index = citations.findIndex(existing => existing.id === reference.id);
                    if (index < 0) { index = citations.length; citations.push(reference); }
                    return index + 1;
                });
                lines.push(escape(claim.text) + numbers.map(number => ` [${number}]`).join(''));
                claims.push({ id: claim.id, citationIds: references.map(reference => reference.id) });
            }
            const partial = supported.length !== draft.claims.length;
            return result(partial ? 'partial' : 'verified', lines.join('\n\n') + (partial ? '\n\n部分内容缺少充分依据，已省略。' : ''),
                { ...base, evidence, facts, citations, claims, expanded: found.expanded, basis: rewriting ? 'user_input' : 'confirmed_sources' });
        } catch (error) {
            if (signal?.aborted) throw error;
            return unavailable(base);
        }
    }

    return { answer, unavailable };
}
