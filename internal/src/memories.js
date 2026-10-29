import { api, query } from './api.js';
import { el, button, input, select, panel, closePanel, notice, empty, badge, formatDate, submitting, confirmAction, toast } from './ui.js';
import { createKnowledgeLibrary, openKnowledgeFile } from './knowledge.js';
import { createGroundingLibrary, openGroundingSource } from './grounding.js';

const scopeLabels = { personal: '个人记忆', project_private: '项目内个人记忆', project_shared: '项目共享记忆' };
const statusLabels = { active: '已生效', candidate: '待审核', inactive: '已停用', rejected: '未通过', conflict: '待确认冲突' };
const indexLabels = { ready: '语义索引就绪', queued: '索引处理中', failed: '语义索引失败', missing: '待建立语义索引', not_required: '' };

export function openMemoryPanel(options) {
    const { user, project, conversationId, onSource } = options;
    let scope = options.initialScope || 'personal';
    let section = ['files', 'facts'].includes(options.initialSection) ? options.initialSection : 'memories';
    if (scope !== 'personal' && !project) scope = 'personal';
    const tabs = el('div', { className: 'panel-tabs', role: 'group', 'aria-label': '记忆范围' });
    const search = input('查找记忆', { type: 'search', placeholder: '搜索偏好、项目事实或关键词', maxlength: 200 });
    const filter = select('状态', [{ value: '', label: '全部状态' }, { value: 'active', label: '已生效' }, { value: 'candidate', label: '待审核与冲突' }, { value: 'inactive', label: '已停用或未通过' }]);
    const result = el('div', { className: 'stack-tight' });
    const errors = el('div');
    const jobs = el('div', { className: 'stack-tight' });
    const introduction = el('div');
    const searchForm = el('form', { className: 'search-row' }, search.wrapper, button('', null, { type: 'submit', glyph: 'search', name: '搜索记忆', className: 'icon-button' }));
    const adding = button('新增记忆', () => editMemory(null), { glyph: 'plus', className: 'button primary' });
    const sections = el('div', { className: 'panel-tabs knowledge-section-tabs', role: 'group', 'aria-label': '记忆库内容' });
    const memoriesContent = el('div', { className: 'stack' }, el('div', { className: 'row-between' }, filter.wrapper, adding), searchForm, errors, result, jobs);
    const reopenFiles = () => openMemoryPanel({ ...options, initialScope: scope, initialSection: 'files' });
    const library = createKnowledgeLibrary({ user, project, scope, onFile: fileId => openKnowledgeFile({ fileId, onBack: reopenFiles }), onReopen: reopenFiles });
    const reopenFacts = () => openMemoryPanel({ ...options, initialScope: scope, initialSection: 'facts' });
    const grounding = createGroundingLibrary({ project, scope, onReopen: reopenFacts });
    const view = panel('记忆库', el('div', { className: 'stack' }, tabs, introduction,
        sections, memoriesContent, library.element, grounding.element),
        { subtitle: '记住工作细节，也让资料成为下一次讨论的背景。' });
    let requestVersion = 0;
    view.dialog.addEventListener('close', () => { requestVersion++; library.dispose(); grounding.dispose(); }, { once: true });

    function renderSections() {
        sections.replaceChildren(...[{ value: 'memories', label: '记忆' }, { value: 'files', label: '资料文件' }, { value: 'facts', label: '事实与确认' }].map(item => button(item.label, () => {
            section = item.value;
            requestVersion++;
            renderSections();
            if (section === 'memories') load();
        }, { className: 'chip' + (section === item.value ? ' active' : ''), 'aria-pressed': String(section === item.value), glyph: item.value === 'files' ? 'folder' : item.value === 'facts' ? 'shield' : 'memory' })));
        memoriesContent.hidden = section !== 'memories';
        introduction.hidden = section !== 'memories';
        library.setActive(section === 'files');
        grounding.setActive(section === 'facts');
    }

    function renderTabs() {
        adding.disabled = scope !== 'personal' && Boolean(project?.archived);
        tabs.replaceChildren(...Object.entries(scopeLabels).map(([value, label]) => button(label, () => {
            scope = value;
            filter.control.value = '';
            renderTabs();
            load();
        }, { className: 'chip' + (scope === value ? ' active' : ''), 'aria-pressed': String(scope === value), disabled: value !== 'personal' && !project })));
        introduction.replaceChildren(notice(scope === 'personal'
            ? '个人记忆用于你的跨会话工作偏好；你可维护，系统管理员可只读审计。'
            : scope === 'project_private'
                ? '这些记忆只用于你在「' + project.name + '」的讨论，不跨项目使用；系统管理员可审计。'
                : '共享记忆属于「' + project.name + '」。候选由项目管理员审核，确认后其他项目成员才能使用。'));
        library.setScope(scope);
        grounding.setScope(scope);
    }

    async function action(callback) {
        errors.replaceChildren();
        try { await callback(); await load(); } catch (error) {
            if (view.dialog.isConnected && error.code !== 'STALE_RESPONSE') errors.replaceChildren(notice(error.message, 'error'));
        }
    }

    async function loadJobs() {
        if (!conversationId) return;
        try {
            const data = await api('/api/memory/jobs' + query({ conversationId }));
            if (!view.dialog.isConnected) return;
            if (!data.jobs?.length) { jobs.replaceChildren(); return; }
            const stateLabels = { queued: '等待整理', running: '正在整理', completed: '已完成', failed: '整理未完成', skipped: '已跳过', cancelled: '已取消', interrupted: '处理中断' };
            jobs.replaceChildren(el('div', { className: 'divider' }), el('h3', { text: '当前讨论的记忆整理' }),
                ...data.jobs.map(job => el('div', { className: 'row-between card' }, el('div', {}, el('span', { text: stateLabels[job.state || job.status] || job.state || job.status }), el('small', { text: ' · ' + formatDate(job.updatedAt || job.createdAt) })),
                    ['failed', 'interrupted'].includes(job.state || job.status) && button('重新整理', () => action(async () => { await api('/api/memory/jobs/' + encodeURIComponent(job.id) + '/retry', { method: 'POST', body: {} }); toast('已重新排队，不会重新生成聊天。'); }), { className: 'button small' }))));
        } catch (error) {
            if (view.dialog.isConnected && error.status !== 403 && error.status !== 404 && error.code !== 'STALE_RESPONSE') jobs.replaceChildren(notice('记忆整理状态暂时无法读取，可点击刷新重试。', 'warning'));
        }
    }

    async function load() {
        if (section === 'files') { await library.refresh(); return; }
        if (section === 'facts') { await grounding.refresh(); return; }
        const version = ++requestVersion;
        result.replaceChildren(empty('正在读取记忆…'));
        errors.replaceChildren();
        try {
            const data = await api('/api/memories' + query({ scope, projectId: scope === 'personal' ? undefined : project?.id, q: search.control.value.trim() }));
            if (version !== requestVersion || !view.dialog.isConnected) return;
            const all = Array.isArray(data.memories) ? data.memories : [];
            const chosen = filter.control.value;
            const memories = all.filter(memory => !chosen || (chosen === 'candidate' ? ['candidate', 'conflict'].includes(memory.status) : chosen === 'inactive' ? ['inactive', 'rejected'].includes(memory.status) : memory.status === chosen));
            if (!memories.length) result.replaceChildren(empty('这里还没有符合条件的记忆', scope === 'project_shared' ? '在项目中继续讨论，或手动添加值得共同记住的事实。' : '你可以手动添加，也可以在完成讨论后让助手自动整理。'));
            else result.replaceChildren(...memories.map(renderMemory));
            const focused = options.focusId ? Array.from(result.children).find(item => item.dataset.memoryId === options.focusId) : null;
            if (focused) { focused.classList.add('memory-highlight'); focused.scrollIntoView({ block: 'nearest' }); }
            await loadJobs();
        } catch (error) {
            if (version !== requestVersion || !view.dialog.isConnected || error.code === 'STALE_RESPONSE') return;
            result.replaceChildren(notice(error.message, 'error'), button('重新读取', load));
        }
    }

    function renderMemory(memory) {
        const pending = ['candidate', 'conflict'].includes(memory.status);
        const actions = el('div', { className: 'card-actions' });
        if (memory.status === 'active') actions.append(button('核对事实依据', () => openGroundingSource({
            reference: { sourceType: 'memory', sourceId: memory.id, version: memory.version }, onBack: reopenFacts,
        }), { glyph: 'shield' }));
        if (memory.canEdit) {
            actions.append(button('编辑', () => editMemory(memory), { glyph: 'edit' }));
            if (['active', 'inactive'].includes(memory.status)) actions.append(button(memory.status === 'active' ? '停用' : '启用', () => action(() => api('/api/memories/' + encodeURIComponent(memory.id), { method: 'PATCH', body: { active: memory.status !== 'active' } }))));
            if (memory.status === 'active' && ['failed', 'missing'].includes(memory.embeddingStatus)) actions.append(button('重建索引', () => action(async () => { await api('/api/memories/' + encodeURIComponent(memory.id) + '/reindex', { method: 'POST', body: {} }); toast('已安排重建语义索引。'); })));
        }
        if (memory.canReview && pending) {
            actions.append(button('确认共享', () => action(() => api('/api/memories/' + encodeURIComponent(memory.id) + '/review', { method: 'POST', body: { decision: 'approve' } })), { glyph: 'check' }), button('不予采用', () => action(() => api('/api/memories/' + encodeURIComponent(memory.id) + '/review', { method: 'POST', body: { decision: 'reject' } }))));
        }
        if (memory.sourceConversationId) actions.append(button('查看来源', () => { closePanel(); onSource(memory.sourceConversationId, memory.sourceMessageId); }));
        if (memory.canEdit || memory.canWithdraw) actions.append(button(memory.canWithdraw && !memory.canEdit ? '撤回候选' : '删除', async () => {
            const approved = await confirmAction('删除这条记忆？', '删除后它将退出后续检索，旧的整理任务不会恢复这条内容。聊天原文不会因此删除。', '删除记忆');
            if (!approved) { openMemoryPanel({ ...options, initialScope: scope }); return; }
            try { await api('/api/memories/' + encodeURIComponent(memory.id), { method: 'DELETE' }); openMemoryPanel({ ...options, initialScope: scope }); toast('记忆已删除。'); } catch (error) { toast(error.message, 'error'); }
        }, { className: 'button danger' }));
        const card = el('article', { className: 'card' }, el('div', { className: 'row-between' }, badge(statusLabels[memory.status] || memory.status, pending ? 'warning' : memory.status === 'active' ? 'accent' : ''), el('small', { text: scopeLabels[memory.scope] || '' })),
            el('p', { className: 'card-content', text: memory.content }), memory.sourceEvidence && el('blockquote', { className: 'memory-evidence', text: '来源摘录：' + memory.sourceEvidence }), el('div', { className: 'card-meta' }, el('span', { text: formatDate(memory.updatedAt || memory.createdAt) }), memory.ownerName && el('span', { text: memory.ownerName }), indexLabels[memory.embeddingStatus] && el('span', { text: indexLabels[memory.embeddingStatus] })), actions);
        card.dataset.memoryId = memory.id;
        return card;
    }

    function editMemory(memory) {
        const currentScope = memory?.scope || scope;
        const content = input('需要记住的内容', { tag: 'textarea', required: true, maxlength: 1200, placeholder: '例如：这个项目的对外表达使用克制、清楚的语气，避免夸大功效。' });
        content.control.value = memory?.content || '';
        const editorErrors = el('div');
        const form = el('form', { className: 'stack' }, notice(scopeLabels[currentScope] + (currentScope !== 'personal' ? ' · ' + project.name : '')),
            content.wrapper, currentScope === 'project_shared' && !memory && project?.role !== 'admin' && notice('新条目将先进入候选，项目管理员确认后才向其他成员开放。'), editorErrors,
            el('div', { className: 'actions' }, button('返回记忆库', () => openMemoryPanel({ ...options, initialScope: currentScope })), button(memory ? '保存修改' : '添加记忆', null, { type: 'submit', className: 'button primary' })));
        const editor = panel(memory ? '编辑记忆' : '新增记忆', form);
        form.addEventListener('submit', event => {
            event.preventDefault();
            submitting(form, async () => {
                const text = content.control.value.trim();
                if (!text) throw new Error('请填写需要记住的内容。');
                await api(memory ? '/api/memories/' + encodeURIComponent(memory.id) : '/api/memories', { method: memory ? 'PATCH' : 'POST', body: memory ? { content: text } : { content: text, scope: currentScope, ...(currentScope === 'personal' ? {} : { projectId: project.id }) } });
                editor.close();
                openMemoryPanel({ ...options, initialScope: currentScope });
                toast('记忆已保存。');
            }, editorErrors);
        });
        content.control.focus();
    }

    searchForm.addEventListener('submit', event => { event.preventDefault(); load(); });
    filter.control.addEventListener('change', load);
    renderTabs();
    renderSections();
    if (section === 'memories') load();
}
