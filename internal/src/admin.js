import { api, query } from './api.js';
import { messageView } from './chat.js';
import { el, button, input, select, panel, notice, empty, badge, formatDate, submitting, toast } from './ui.js';

export { openControlPanel as openAccountsPanel } from './control-panel.js';

export function openAuditPanel(initial = {}) {
    let type = initial.type || 'conversations';
    let page = initial.page || 1;
    let version = 0;
    const results = el('div', { className: 'stack-tight audit-results' });
    const tabs = el('div', { className: 'panel-tabs', role: 'tablist', 'aria-label': '审计范围' });
    const person = input('用户 ID（可选）', { placeholder: '所有内部账号', value: initial.userId || '' });
    const project = input('项目 ID（可选）', { placeholder: '全部项目及个人空间', value: initial.projectId || '' });
    const search = input('查找内容', { type: 'search', placeholder: '关键词', value: initial.q || '' });
    const from = input('起始日期', { type: 'date', value: initial.from || '' });
    const to = input('截止日期', { type: 'date', value: initial.to || '' });
    const form = el('form', { className: 'stack-tight' }, el('div', { className: 'audit-toolbar' }, person.wrapper, project.wrapper, search.wrapper, button('筛选', null, { type: 'submit', glyph: 'search' })),
        el('div', { className: 'form-grid' }, from.wrapper, to.wrapper));
    const view = panel('全局只读审计', el('div', { className: 'stack-tight' }, notice('此入口可以查看全局原始聊天、记忆和资料文件，访问行为会被记录。审计内容不会加入你的聊天上下文；这里不提供编辑、删除或生成操作。'), tabs, form, results), { wide: true, subtitle: '仅系统管理员可用 · 每次访问均记录审计事件' });
    function filters() { return { type, page, userId: person.control.value.trim(), projectId: project.control.value.trim(), q: search.control.value.trim(), from: from.control.value, to: to.control.value }; }
    function renderTabs() {
        tabs.replaceChildren(...[{ value: 'conversations', label: '原始聊天' }, { value: 'memories', label: '全部记忆' }, { value: 'files', label: '资料文件' }, { value: 'events', label: '访问与操作记录' }].map(item => button(item.label, () => { type = item.value; page = 1; renderTabs(); load(); }, { className: 'chip' + (type === item.value ? ' active' : ''), role: 'tab', 'aria-selected': type === item.value })));
    }
    function source(id) { openAuditConversation(id, filters()); }
    async function load() {
        const current = ++version;
        results.replaceChildren(empty('正在读取审计记录…'));
        const values = filters();
        let end = values.to ? new Date(values.to + 'T23:59:59.999').toISOString() : '';
        const start = values.from ? new Date(values.from + 'T00:00:00').toISOString() : '';
        try {
            const data = await api('/api/admin/audit/' + type + query({ userId: values.userId, projectId: values.projectId, q: values.q, from: start, to: end, offset: (page - 1) * 50, limit: 50 }));
            if (!view.dialog.isConnected || current !== version) return;
            const rows = data[type] || [];
            const content = rows.map(row => {
                if (type === 'conversations') return el('button', { type: 'button', className: 'card clickable-card list-button', onclick: () => source(row.id) },
                    el('div', { className: 'row-between' }, el('h3', { text: row.title || '未命名聊天' }), badge(row.projectId ? '项目聊天' : '个人聊天')),
                    el('div', { className: 'card-meta' }, el('span', { text: row.ownerName || row.displayName || row.username || row.userId }), row.projectName && el('span', { text: row.projectName }), el('time', { text: formatDate(row.updatedAt) })),
                    el('small', { text: '项目 ID：' + (row.projectId || '个人空间') }));
                if (type === 'memories') return el('article', { className: 'card' },
                    el('div', { className: 'row-between' }, badge({ personal: '个人记忆', project_private: '项目私有记忆', project_shared: '项目共享记忆' }[row.scope] || row.scope), badge(row.status)),
                    el('p', { className: 'card-content', text: row.content }),
                    el('div', { className: 'card-meta' }, el('span', { text: row.ownerName || row.displayName || row.userId }), el('time', { text: formatDate(row.updatedAt) }), row.projectId && el('span', { text: '项目 ' + row.projectId })),
                    row.sourceConversationId && el('div', { className: 'card-actions' }, button('审计来源聊天', () => source(row.sourceConversationId), { className: 'button small', glyph: 'chat' })));
                if (type === 'files') return el('button', { type: 'button', className: 'card clickable-card list-button', onclick: () => openAuditFile(row.id, filters()) },
                    el('div', { className: 'row-between' }, el('h3', { text: row.name || row.filename || '资料文件' }), badge({ personal: '个人资料', project_private: '项目私有资料', project_shared: '项目共享资料' }[row.scope] || row.scope)),
                    el('div', { className: 'card-meta' }, el('span', { text: row.ownerName || row.userId }), el('time', { text: formatDate(row.updatedAt) }), el('span', { text: { queued: '等待解析', running: '正在处理', ready: '可检索', failed: '处理失败', interrupted: '处理已中断' }[row.state] || row.state })),
                    el('small', { text: row.projectName || (row.projectId ? '项目 ' + row.projectId : '个人空间') }));
                return el('article', { className: 'card' }, el('div', { className: 'row-between' }, el('h3', { text: eventName(row.action) }), el('time', { className: 'subtle', text: formatDate(row.createdAt) })),
                    el('div', { className: 'card-meta' }, el('span', { text: row.actorName || row.actorUsername || row.actorId || '系统' }), el('span', { text: row.targetType + (row.targetId ? ' · ' + row.targetId : '') })),
                    el('p', { className: 'audit-event', text: typeof row.details === 'object' ? JSON.stringify(row.details) : row.details || '' }));
            });
            const hasMore = data.hasMore ?? data.pagination?.hasMore ?? rows.length === 50;
            results.replaceChildren(...(content.length ? content : [empty('没有符合条件的记录', '调整关键词、用户或时间范围后重试。')]),
                el('div', { className: 'pagination' }, button('上一页', () => { page--; load(); }, { disabled: page === 1 }), el('span', { text: '第 ' + page + ' 页' }), button('下一页', () => { page++; load(); }, { disabled: !hasMore })));
        } catch (error) { if (view.dialog.isConnected && current === version && error.code !== 'STALE_RESPONSE') results.replaceChildren(notice(error.message, 'error'), button('重新读取', load)); }
    }
    form.addEventListener('submit', event => { event.preventDefault(); page = 1; load(); });
    renderTabs(); load();
    api('/api/admin/users').then(data => {
        if (!view.dialog.isConnected) return;
        const options = [{ value: '', label: '所有内部账号' }, ...(data.users || []).map(account => ({ value: account.id, label: account.displayName + ' · ' + account.username }))];
        const picker = select('筛选用户', options, person.control.value);
        person.wrapper.replaceChildren(...picker.wrapper.childNodes);
        person.control = picker.control;
    }).catch(() => {});
}

function openAuditConversation(id, previous) {
    const content = el('div', { className: 'stack' }, empty('正在读取原始聊天…'));
    const view = panel('原始聊天审计', el('div', { className: 'stack' }, button('返回审计列表', () => openAuditPanel(previous), { glyph: 'back', className: 'button quiet' }), content), { wide: true, subtitle: '只读 · 不加入日常聊天上下文' });
    api('/api/admin/audit/conversations/' + encodeURIComponent(id)).then(data => {
        if (!view.dialog.isConnected) return;
        content.replaceChildren(el('div', { className: 'stack-tight' }, el('h3', { text: data.conversation.title || '未命名聊天' }), notice('会话所有者：' + (data.conversation.ownerName || data.conversation.userId) + ' · ' + (data.conversation.projectName || (data.conversation.projectId ? '项目聊天' : '个人聊天')))),
            el('div', { className: 'audit-conversation' }, ...(data.messages?.length ? data.messages.map(message => messageView(message, { audit: true }).element) : [empty('这段聊天还没有消息')])));
    }).catch(error => { if (view.dialog.isConnected && error.code !== 'STALE_RESPONSE') content.replaceChildren(notice(error.message, 'error')); });
}

function openAuditFile(id, previous) {
    const content = el('div', { className: 'stack' }, empty('正在读取资料文件…'));
    const view = panel('资料文件审计', el('div', { className: 'stack' }, button('返回审计列表', () => openAuditPanel(previous), { glyph: 'back', className: 'button quiet' }), content), { wide: true, subtitle: '只读 · 不加入日常聊天上下文' });
    api('/api/admin/audit/files/' + encodeURIComponent(id)).then(data => {
        if (!view.dialog.isConnected) return;
        content.replaceChildren(el('h3', { text: data.file.name || data.file.filename || '资料文件' }),
            notice('资料所有者：' + (data.file.ownerName || data.file.userId) + ' · ' + (data.file.projectName || (data.file.projectId ? '项目资料' : '个人资料'))),
            data.text ? el('pre', { className: 'knowledge-preview', text: data.text }) : empty('暂无可预览的文字', '文件可能仍在解析、解析失败，或已被删除。'));
    }).catch(error => { if (view.dialog.isConnected && error.code !== 'STALE_RESPONSE') content.replaceChildren(notice(error.message, 'error')); });
}

function eventName(value) {
    return ({ 'audit.conversations_list': '查看全局聊天列表', 'audit.conversation_read': '查看原始聊天', 'audit.memories_list': '查看全局记忆', 'audit.files_list': '查看全局资料列表', 'audit.file_read': '查看资料文件', 'audit.events_list': '查看审计事件', 'user.create': '创建内部账号', 'user.update': '更新内部账号', 'user.password_reset': '重置账号密码', 'project.conversation.read': '项目管理员查看聊天', 'project.conversations.list': '项目管理员查看聊天列表' })[value] || value;
}
