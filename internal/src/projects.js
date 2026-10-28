import { api } from './api.js';
import { el, button, input, select, panel, notice, empty, badge, submitting, confirmAction, toast } from './ui.js';

export function createProjectPanel(onCreated) {
    const name = input('项目名称', { required: true, maxlength: 120, placeholder: '例如：品牌秋季内容计划' });
    const description = input('项目背景', { tag: 'textarea', maxlength: 2000, placeholder: '说明项目的目标、目前进展和重要背景。' });
    const instructions = input('项目工作指令', { tag: 'textarea', maxlength: 8000, placeholder: '希望助手在这个项目中遵循哪些表达方式、工作原则或约束？' });
    const errors = el('div');
    const form = el('form', { className: 'stack' }, name.wrapper, description.wrapper, instructions.wrapper,
        notice('项目内的每位成员保有自己的聊天；项目管理员可查看项目全部原始聊天，系统管理员可全局审计。'), errors,
        button('创建项目空间', null, { className: 'button primary', type: 'submit', glyph: 'plus' }));
    const view = panel('创建项目空间', form, { subtitle: '给相关的讨论、背景和记忆一个共同的地方。' });
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const data = await api('/api/projects', { method: 'POST', body: { name: name.control.value.trim(), description: description.control.value.trim(), instructions: instructions.control.value.trim() } });
            view.close();
            await onCreated(data.project);
            toast('项目空间已创建。');
        }, errors);
    });
    name.control.focus();
}

export function openProjectPanel({ user, project, onChanged }) {
    const canManage = project.role === 'admin';
    const writable = canManage && !project.archived;
    const name = input('项目名称', { required: true, maxlength: 120, value: project.name, disabled: !writable });
    const description = input('项目背景', { tag: 'textarea', maxlength: 2000, value: project.description || '', disabled: !writable });
    const instructions = input('项目工作指令', { tag: 'textarea', maxlength: 8000, value: project.instructions || '', disabled: !writable });
    const errors = el('div');
    const members = el('div', { className: 'stack-tight' }, empty('正在读取项目成员…'));
    const memberErrors = el('div');
    const memberFormHost = el('div');
    const form = el('form', { className: 'stack' }, name.wrapper, description.wrapper, instructions.wrapper,
        writable && button('保存项目信息', null, { type: 'submit', className: 'button primary' }), errors);
    const view = panel('项目空间', el('div', { className: 'stack' }, el('div', { className: 'row-between' }, el('div', {}, el('h3', { text: project.name }), el('small', { text: '你在此项目的角色：' + (canManage ? '项目管理员' : '成员') })), project.archived && badge('已归档')),
        notice(project.archived ? '此项目已归档，聊天、项目信息和共享记忆保持只读。' : '项目成员各自的聊天互不可见；项目管理员可查看本项目全部聊天，系统管理员可全局审计。'),
        form, el('div', { className: 'divider' }), el('h3', { text: '项目成员' }), memberErrors, members, memberFormHost,
        canManage && el('div', { className: 'stack-tight' }, el('div', { className: 'divider' }), button(project.archived ? '恢复项目' : '归档项目', async () => {
            const accepted = await confirmAction(project.archived ? '恢复这个项目？' : '归档这个项目？', project.archived ? '恢复后，成员可以继续发起讨论和更新项目内容。' : '归档后项目保持只读，不会删除已有聊天和记忆。', project.archived ? '恢复项目' : '归档项目');
            if (!accepted) { openProjectPanel({ user, project, onChanged }); return; }
            try {
                const data = await api('/api/projects/' + encodeURIComponent(project.id), { method: 'PATCH', body: { archived: !project.archived } });
                await onChanged(data.project);
                toast(project.archived ? '项目已恢复。' : '项目已归档。');
            } catch (error) { toast(error.message, 'error'); }
        }, { glyph: 'archive', className: 'button quiet' }))), { subtitle: '背景与指令只影响当前项目。' });
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const data = await api('/api/projects/' + encodeURIComponent(project.id), { method: 'PATCH', body: { name: name.control.value.trim(), description: description.control.value.trim(), instructions: instructions.control.value.trim() } });
            view.close();
            await onChanged(data.project);
            toast('项目信息已保存。');
        }, errors);
    });

    async function updateMember(callback, affectedUserId) {
        memberErrors.replaceChildren();
        try {
            await callback();
            if (affectedUserId === user.id) { view.close(); await onChanged(); return; }
            await loadMembers();
            await onChanged();
        } catch (error) { if (view.dialog.isConnected && error.code !== 'STALE_RESPONSE') memberErrors.replaceChildren(notice(error.message, 'error')); }
    }

    async function loadMembers() {
        try {
            const data = await api('/api/projects/' + encodeURIComponent(project.id) + '/members');
            if (!view.dialog.isConnected) return;
            const list = data.members || [];
            const adminCount = list.filter(member => member.role === 'admin').length;
            members.replaceChildren(...list.map(member => {
                const memberId = member.userId || member.id;
                const role = select('成员角色', [{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }], member.role);
                role.control.setAttribute('aria-label', (member.displayName || member.username) + '的项目角色');
                role.control.disabled = !writable || member.role === 'admin' && adminCount === 1;
                role.control.addEventListener('change', () => updateMember(() => api('/api/projects/' + encodeURIComponent(project.id) + '/members/' + encodeURIComponent(memberId), { method: 'PUT', body: { role: role.control.value } }), memberId));
                return el('div', { className: 'list-row' }, el('span', { className: 'initials', text: (member.displayName || member.username || '成员').slice(0, 1) }),
                    el('div', { className: 'flex' }, el('p', { className: 'row-title', text: (member.displayName || member.username || '成员') + (memberId === user.id ? '（你）' : '') }), el('p', { className: 'row-subtitle', text: member.username || '' })),
                    canManage ? el('div', { className: 'row-actions' }, role.control, button('', async () => {
                        const accepted = await confirmAction('移除这位项目成员？', '移除后，该成员将失去本项目的访问权。', '移除成员');
                        if (!accepted) { openProjectPanel({ user, project, onChanged }); return; }
                        try {
                            await api('/api/projects/' + encodeURIComponent(project.id) + '/members/' + encodeURIComponent(memberId), { method: 'DELETE' });
                            await onChanged();
                            if (memberId !== user.id) openProjectPanel({ user, project, onChanged });
                            toast('项目成员已移除。');
                        } catch (error) { toast(error.message, 'error'); }
                    }, { className: 'icon-button small', glyph: 'close', name: '移除' + (member.displayName || member.username), disabled: !writable || member.role === 'admin' && adminCount === 1 })) : badge(member.role === 'admin' ? '项目管理员' : '成员'));
            }));
            if (!writable) return;
            const directory = await api('/api/users/directory');
            if (!view.dialog.isConnected) return;
            const available = (directory.users || []).filter(person => !list.some(member => (member.userId || member.id) === person.id));
            if (!available.length) { memberFormHost.replaceChildren(el('small', { text: '当前没有其他可添加的内部账号。新账号由系统管理员创建。' })); return; }
            const person = select('添加项目成员', available.map(item => ({ value: item.id, label: item.displayName + ' · ' + item.username })));
            const role = select('角色', [{ value: 'member', label: '成员' }, { value: 'admin', label: '项目管理员' }]);
            const adding = el('form', { className: 'stack-tight' }, el('div', { className: 'form-grid' }, person.wrapper, role.wrapper), button('添加成员', null, { type: 'submit', glyph: 'plus' }));
            adding.addEventListener('submit', event => {
                event.preventDefault();
                submitting(adding, () => updateMember(() => api('/api/projects/' + encodeURIComponent(project.id) + '/members/' + encodeURIComponent(person.control.value), { method: 'PUT', body: { role: role.control.value } }), person.control.value), memberErrors);
            });
            memberFormHost.replaceChildren(adding);
        } catch (error) {
            if (view.dialog.isConnected && error.code !== 'STALE_RESPONSE') members.replaceChildren(notice(error.message, 'error'), button('重试读取成员', loadMembers));
        }
    }
    loadMembers();
}
