import { api, query, getSession } from './api.js';
import { el, button, input, panel, notice, empty, badge, formatDate, submitting } from './ui.js';
import { createGroundingRequests, sourceIdentity, sourceRoute, sourceVersionChanged, factCandidateBody, factPeriodLabel } from './grounding-state.js';

const scopes = { personal: '个人资料', project_private: '项目内个人资料', project_shared: '项目共享资料' };
const ignored = error => error.name === 'AbortError' || error.code === 'STALE_RESPONSE';
const sourceName = source => source.title || (source.type === 'file' || source.sourceType === 'file' ? '资料文件' : '记忆条目');
const factName = fact => fact.entity + ' · ' + fact.field;
const factValue = fact => String(fact.value ?? '') + (fact.unit ? ' ' + fact.unit : '');
const stateName = fact => fact.needsReconfirmation ? '需重新确认' : fact.confirmed || fact.status === 'confirmed' ? '已确认事实' : fact.status === 'revoked' ? '已撤销' : '待人工确认';
function boundSession() {
    const session = getSession();
    return () => getSession()?.user?.id === session?.user?.id && getSession()?.csrfToken === session?.csrfToken;
}

export function createGroundingLibrary({ project, scope: initialScope = 'personal', onReopen }) {
    let scope = initialScope, active = false, disposed = false, section = 'sources', page = 1;
    const sameSession = boundSession();
    const results = el('div', { className: 'stack-tight grounding-results' });
    const errors = el('div');
    const tabs = el('div', { className: 'panel-tabs', role: 'group', 'aria-label': '事实确认内容' });
    const search = input('查找来源与事实', { type: 'search', maxlength: 200, placeholder: '来源名称、对象或事实字段' });
    const searchForm = el('form', { className: 'search-row' }, search.wrapper, button('', null, { type: 'submit', glyph: 'search', name: '搜索来源与事实', className: 'icon-button' }));
    const pagination = el('div', { className: 'pagination' });
    const element = el('section', { className: 'stack grounding-library', 'aria-label': '事实与确认' },
        notice('重要业务事实先核对来源，再人工确认。修改来源后，旧确认将失效；自动记忆仍可保存工作偏好。'),
        tabs, searchForm, errors, results, pagination);
    const connected = () => !disposed && active && element.isConnected && sameSession();
    const requests = createGroundingRequests({ isConnected: connected });

    function renderTabs() {
        tabs.replaceChildren(...[{ value: 'sources', label: '来源确认' }, { value: 'facts', label: '标准事实' }].map(item =>
            button(item.label, () => { section = item.value; page = 1; requests.advance(); renderTabs(); load(); },
                { className: 'chip' + (item.value === section ? ' active' : ''), 'aria-pressed': String(item.value === section) })));
    }
    function back() { onReopen?.(); }
    function sourceCard(source) {
        return el('article', { className: 'card grounding-source-card' },
            el('div', { className: 'row-between' }, badge(source.confirmed ? '已确认依据' : source.needsReconfirmation ? '需重新确认' : '待确认依据', source.confirmed ? 'accent' : 'warning'),
                el('small', { text: (source.type === 'file' ? '文件' : '记忆') + ' · v' + source.version })),
            el('h3', { className: 'grounding-card-title', text: sourceName(source) }),
            source.content && el('p', { className: 'card-content grounding-source-excerpt', text: source.content.slice(0, 220) }),
            source.confirmation && el('div', { className: 'card-meta', text: '确认时间 ' + formatDate(source.confirmation.confirmedAt) }),
            el('div', { className: 'card-actions' }, button('查看与确认', () => openGroundingSource({ reference: source, onBack: back }), { glyph: 'shield' })));
    }
    function factCard(fact) {
        return el('article', { className: 'card grounding-fact-card' },
            el('div', { className: 'row-between' }, badge(stateName(fact), fact.confirmed ? 'accent' : 'warning'), el('small', { text: '来源 v' + fact.sourceVersion })),
            el('h3', { className: 'grounding-card-title', text: factName(fact) }),
            el('p', { className: 'grounding-fact-value', text: factValue(fact) }),
            factPeriodLabel(fact) && el('p', { className: 'muted', text: factPeriodLabel(fact) }),
            fact.conditions && el('p', { className: 'card-content', text: '适用条件：' + fact.conditions }),
            fact.evidence && el('blockquote', { className: 'grounding-evidence', text: fact.evidence }),
            el('div', { className: 'card-actions' }, button('查看事实', () => openGroundingFact({ factId: fact.id, onBack: back }), { glyph: 'shield' })));
    }
    async function load() {
        if (!connected()) return;
        requests.advance();
        const lease = requests.capture();
        const targetSection = section;
        errors.replaceChildren(); results.replaceChildren(empty('正在读取已确认资料…')); pagination.replaceChildren();
        try {
            const data = await api('/api/grounding/' + targetSection + query({ scope, projectId: scope === 'personal' ? undefined : project?.id,
                q: search.control.value.trim(), limit: 25, offset: (page - 1) * 25 }), { signal: requests.signal() });
            if (!requests.current(lease)) return;
            const rows = Array.isArray(data[targetSection]) ? data[targetSection] : [];
            results.replaceChildren(...(rows.length ? rows.map(targetSection === 'sources' ? sourceCard : factCard)
                : [empty(targetSection === 'sources' ? '这个范围还没有可确认的来源' : '这个范围还没有标准事实', targetSection === 'sources' ? '先添加记忆或上传资料，再确认可作为回答依据的版本。' : '在“来源确认”中打开资料，可以填写并确认标准事实。')]));
            pagination.replaceChildren(button('上一页', () => { page--; load(); }, { disabled: page <= 1 }), el('span', { text: '第 ' + page + ' 页' }),
                button('下一页', () => { page++; load(); }, { disabled: !data.hasMore }));
        } catch (error) {
            if (!requests.current(lease) || ignored(error)) return;
            results.replaceChildren(notice(error.message || '资料暂时无法读取。', 'error'), button('重新读取', load));
        }
    }
    searchForm.addEventListener('submit', event => { event.preventDefault(); page = 1; load(); });
    renderTabs();
    return { element, refresh: load,
        setScope(value) { if (value === scope) return; scope = value; page = 1; search.control.value = ''; requests.advance(); results.replaceChildren(); },
        setActive(value) { active = value; element.hidden = !value; if (value) load(); else requests.advance(); },
        dispose() { disposed = true; requests.dispose(); },
    };
}

export function openGroundingSource({ reference, onBack }) {
    const sameSession = boundSession();
    const content = el('div', { className: 'stack grounding-detail' }, empty('正在读取来源…'));
    const view = panel('核对事实来源', content, { wide: true, subtitle: '以当前可访问的资料版本为准。' });
    const requests = createGroundingRequests({ isConnected: () => view.dialog.isConnected && sameSession() });
    view.dialog.addEventListener('close', () => requests.dispose(), { once: true });
    const lease = requests.capture();
    const errors = el('div');
    let currentSource;
    function render(source) {
        currentSource = source;
        const changed = sourceVersionChanged(reference, source);
        const actions = el('div', { className: 'actions grounding-actions' });
        if (onBack) actions.append(button('返回事实与确认', onBack, { glyph: 'back' }));
        if (source.canConfirm && !source.confirmed) actions.append(button('确认此版本为依据', () => mutate('confirm'), { className: 'button primary', glyph: 'check' }));
        if (source.canRevoke && source.confirmed) actions.append(button('撤销此版本确认', () => mutate('revoke'), { className: 'button danger' }));
        if (source.canConfirm || source.canRevoke) actions.append(button('整理事实候选', () => suggest(), { glyph: 'spark' }));
        if (source.canConfirm || source.canRevoke) actions.append(button('新增标准事实', () => openFactEditor({ source, onBack: () => openGroundingSource({ reference: source, onBack }) }), { glyph: 'plus' }));
        const quote = typeof reference.quote === 'string' && !changed && source.content?.includes(reference.quote) ? reference.quote : '';
        content.replaceChildren(...[
            el('div', { className: 'row-between' }, el('h3', { text: sourceName(source) }), badge(source.confirmed ? '当前版本已确认' : '当前版本待确认', source.confirmed ? 'accent' : 'warning')),
            el('div', { className: 'card-meta' }, el('span', { text: scopes[source.scope] || '' }), el('span', { text: '版本 v' + source.version }),
                source.confirmation && el('span', { text: '确认于 ' + formatDate(source.confirmation.confirmedAt) })),
            changed && notice('这条回答引用的是 v' + reference.version + '，当前来源已更新至 v' + source.version + '。旧引用不能作为当前事实依据，请核对下方当前内容。', 'warning'),
            !source.confirmed && notice(source.needsReconfirmation ? '来源内容或确认状态已变化，需要重新确认；旧事实不会自动沿用。' : '确认前，请核对原文是否正确且适用于当前项目。重要事实只有确认后才会作为正式回答依据。', 'warning'),
            quote && el('section', { className: 'grounding-citation-excerpt' }, el('h4', { text: Number.isInteger(reference.chunkIndex) ? '本次引用片段 · 第 ' + (reference.chunkIndex + 1) + ' 段' : '本次引用片段' }), el('blockquote', { className: 'grounding-evidence', text: quote })),
            el('section', { className: 'grounding-source-content' }, el('h4', { text: '当前来源原文' }), el('pre', { className: 'grounding-source-text', text: source.content || '来源当前没有可展示的文字。' })), errors, actions].filter(Boolean));
    }
    async function mutate(action) {
        const buttons = Array.from(content.querySelectorAll('button'));
        buttons.forEach(button => { button.disabled = true; }); errors.replaceChildren();
        try {
            const data = await api(sourceRoute(currentSource) + '/' + action, { method: 'POST', body: { version: currentSource.version } });
            if (!requests.current(lease)) return;
            render(data.source);
        } catch (error) {
            if (requests.current(lease) && !ignored(error)) errors.replaceChildren(notice(error.message, 'error'));
        } finally { buttons.forEach(button => { button.disabled = false; }); }
    }
    async function suggest() {
        const buttons = Array.from(content.querySelectorAll('button'));
        buttons.forEach(button => { button.disabled = true; });
        errors.replaceChildren(notice('正在整理候选，完成后仍需逐条人工确认。'));
        try {
            const data = await api(sourceRoute(currentSource) + '/suggest-facts', { method: 'POST', body: { version: currentSource.version } });
            if (!requests.current(lease)) return;
            const facts = Array.isArray(data.facts) ? data.facts : [];
            errors.replaceChildren(notice((facts.length ? '已整理 ' + facts.length + ' 条候选，请核对后逐条确认。' : '未找到可可靠整理的标准事实。可手动新增。') + (data.partial ? '本次只整理了部分内容。' : '')),
                ...facts.map(fact => el('article', { className: 'card' }, el('strong', { text: factName(fact) }),
                    el('p', { className: 'card-content', text: factValue(fact) }), button('核对候选', () => openGroundingFact({ factId: fact.id,
                        onBack: () => openGroundingSource({ reference: currentSource, onBack }) }), { glyph: 'shield' }))));
        } catch (error) { if (requests.current(lease) && !ignored(error)) errors.replaceChildren(notice(error.message, 'error')); }
        finally { buttons.forEach(button => { button.disabled = false; }); }
    }
    api(sourceRoute(reference), { signal: requests.signal() }).then(data => {
        if (requests.current(lease)) render(data.source);
    }).catch(error => {
        if (!requests.current(lease) || ignored(error)) return;
        content.replaceChildren(...[notice(error.status === 403 || error.status === 404 ? '来源已失效或当前账号无权查看，不能继续核实这条引用。' : error.message, 'warning'), onBack && button('返回事实与确认', onBack)].filter(Boolean));
    });
}

function openFactEditor({ source, fact, onBack }) {
    const sameSession = boundSession();
    const fields = {
        entity: input('对象名称', { required: true, maxlength: 160, value: fact?.entity || '', placeholder: '例如：某个产品、门店或制度名称' }),
        field: input('事实字段', { required: true, maxlength: 80, value: fact?.field || '', placeholder: '例如：零售价、规格、适用范围' }),
        value: input('原始值', { required: true, maxlength: 300, value: fact?.value || '', placeholder: '按原文填写，保留数字精度' }),
        unit: input('单位', { maxlength: 40, value: fact?.unit || '', placeholder: '例如：元、ml；原文没有则留空' }),
        aliases: input('对象别称', { maxlength: 1000, value: (fact?.aliases || []).join('，'), placeholder: '可选，多个别称用逗号分隔' }),
        evidence: input('来源原文摘录', { tag: 'textarea', required: true, maxlength: 3000, rows: 5, value: fact?.evidence || '', placeholder: '从来源复制能完整支持这个对象、字段和原始值的原文' }),
        conditions: input('适用条件', { tag: 'textarea', maxlength: 3000, rows: 3, value: fact?.conditions || '', placeholder: '有会员、起订量等限制时，复制含限制的完整证据原文' }),
        validFrom: input('生效日期', { type: 'date', value: fact?.validFrom || '' }),
        validUntil: input('截止日期', { type: 'date', value: fact?.validUntil || '' }),
    };
    const errors = el('div');
    const form = el('form', { className: 'stack grounding-fact-form' },
        notice(sourceName(source) + ' · 来源 v' + source.version),
        notice('保存后进入待人工确认，不会自动作为标准答案。原始值和单位必须有当前来源原文支持。'),
        el('div', { className: 'form-grid' }, fields.entity.wrapper, fields.field.wrapper, fields.value.wrapper, fields.unit.wrapper),
        fields.aliases.wrapper, fields.evidence.wrapper, fields.conditions.wrapper,
        notice('证据带有历史或限期时，请填写原文支持的起止日期；修改后需要重新确认。'),
        el('div', { className: 'form-grid' }, fields.validFrom.wrapper, fields.validUntil.wrapper), errors,
        el('div', { className: 'actions' }, button('返回来源', onBack, { glyph: 'back' }), button('保存待确认事实', null, { type: 'submit', className: 'button primary' })));
    const view = panel(fact ? '编辑标准事实' : '新增标准事实', form, { wide: true });
    const requests = createGroundingRequests({ isConnected: () => view.dialog.isConnected && sameSession() });
    view.dialog.addEventListener('close', () => requests.dispose(), { once: true });
    const lease = requests.capture();
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.control.value]));
            const body = factCandidateBody(source, values);
            const data = await api(fact ? '/api/grounding/facts/' + encodeURIComponent(fact.id) : '/api/grounding/facts', {
                method: fact ? 'PATCH' : 'POST', body: fact ? { version: fact.version, entity: body.entity, field: body.field, value: body.value, unit: body.unit, aliases: body.aliases, evidence: body.evidence,
                    conditions: body.conditions || '', validFrom: body.validFrom || null, validUntil: body.validUntil || null, evidenceChunkId: null } : body });
            if (!requests.current(lease)) return;
            renderFactDetail({ view, content: form, fact: data.fact, onBack, requests, lease });
        }, errors);
    });
    fields.entity.control.focus();
}

function renderFactDetail({ view, content, fact, onBack, requests, lease }) {
    const errors = el('div');
    const actions = el('div', { className: 'actions grounding-actions' });
    if (onBack) actions.append(button('返回事实与确认', onBack, { glyph: 'back' }));
    actions.append(button('查看来源原文', () => openGroundingSource({ reference: { sourceType: fact.sourceType, sourceId: fact.sourceId, version: fact.sourceVersion, quote: fact.evidence },
        onBack: () => openGroundingFact({ factId: fact.id, onBack }) }), { glyph: 'folder' }));
    if (fact.canConfirm && !fact.confirmed) actions.append(button('确认标准事实', () => mutate('confirm'), { className: 'button primary', glyph: 'check' }));
    if (fact.canRevoke && fact.confirmed) actions.append(button('撤销事实确认', () => mutate('revoke'), { className: 'button danger' }));
    if (fact.canEdit) actions.append(button('编辑事实', async () => {
        try {
            const source = await api(sourceRoute({ sourceType: fact.sourceType, sourceId: fact.sourceId }), { signal: requests.signal() });
            if (requests.current(lease)) openFactEditor({ source: source.source, fact, onBack: () => openGroundingFact({ factId: fact.id, onBack }) });
        } catch (error) { if (requests.current(lease) && !ignored(error)) errors.replaceChildren(notice(error.message, 'error')); }
    }, { glyph: 'edit' }));
    content.replaceChildren(...[
        el('div', { className: 'row-between' }, el('h3', { text: factName(fact) }), badge(stateName(fact), fact.confirmed ? 'accent' : 'warning')),
        el('p', { className: 'grounding-fact-value', text: factValue(fact) }),
        factPeriodLabel(fact) && notice(factPeriodLabel(fact), 'warning'),
        fact.conditions && el('p', { className: 'card-content', text: '适用条件：' + fact.conditions }),
        el('div', { className: 'card-meta' }, el('span', { text: scopes[fact.scope] || '' }), el('span', { text: '来源 v' + fact.sourceVersion }),
            fact.confirmedAt && el('span', { text: '确认于 ' + formatDate(fact.confirmedAt) })),
        Boolean(fact.aliases?.length) && el('p', { className: 'muted', text: '对象别称：' + fact.aliases.join('、') }),
        fact.needsReconfirmation && notice('当前来源或确认状态已变化。请先确认当前来源，再核对并重新确认这条事实。', 'warning'),
        el('section', {}, el('h4', { text: '事实依据原文' }), el('blockquote', { className: 'grounding-evidence', text: fact.evidence })), errors, actions].filter(Boolean));
    async function mutate(action) {
        const buttons = Array.from(actions.querySelectorAll('button'));
        buttons.forEach(button => { button.disabled = true; }); errors.replaceChildren();
        try {
            const data = await api('/api/grounding/facts/' + encodeURIComponent(fact.id) + '/' + action, { method: 'POST', body: { version: fact.version } });
            if (requests.current(lease)) renderFactDetail({ view, content, fact: data.fact, onBack, requests, lease });
        } catch (error) { if (requests.current(lease) && !ignored(error)) errors.replaceChildren(notice(error.message, 'error')); }
        finally { buttons.forEach(button => { button.disabled = false; }); }
    }
}

export function openGroundingFact({ factId, onBack }) {
    const sameSession = boundSession();
    const content = el('div', { className: 'stack grounding-detail' }, empty('正在读取标准事实…'));
    const view = panel('核对标准事实', content, { wide: true });
    const requests = createGroundingRequests({ isConnected: () => view.dialog.isConnected && sameSession() });
    view.dialog.addEventListener('close', () => requests.dispose(), { once: true });
    const lease = requests.capture();
    api('/api/grounding/facts/' + encodeURIComponent(factId), { signal: requests.signal() }).then(data => {
        if (requests.current(lease)) renderFactDetail({ view, content, fact: data.fact, onBack, requests, lease });
    }).catch(error => {
        if (!requests.current(lease) || ignored(error)) return;
        content.replaceChildren(...[notice(error.status === 403 || error.status === 404 ? '事实已失效或当前账号无权查看。' : error.message, 'warning'), onBack && button('返回事实与确认', onBack)].filter(Boolean));
    });
}
