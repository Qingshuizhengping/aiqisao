import { api, query } from './api.js';
import { el, button, input, select, panel, notice, empty, badge, formatDate, submitting, toast } from './ui.js';
import { createLifecycleOwner } from './selection-lifecycle.js';

const roleName = role => role === 'admin' ? '系统管理员' : '普通成员';
const stateName = account => account.deletedAt ? '已删除' : account.active ? '已启用' : '已停用';

export function openControlPanel(user, { onClose, onAudit, onChanged } = {}) {
    if (user?.systemRole !== 'admin') { toast('控制面板仅对系统管理员开放。', 'error'); return; }
    let accounts = [], projects = [], page = 1, selectedId = null, hasMore = false;
    const directoryOwner = createLifecycleOwner();
    const editorOwner = createLifecycleOwner();
    let reading, permissionReading;
    const search = input('查找账号', { type: 'search', placeholder: '姓名或登录账号', maxlength: 200 });
    const role = select('系统角色', [{ value: '', label: '全部角色' }, { value: 'member', label: '普通成员' }, { value: 'admin', label: '系统管理员' }]);
    const state = select('账号状态', [{ value: 'current', label: '全部有效账号' }, { value: 'active', label: '已启用' }, { value: 'disabled', label: '已停用' }, { value: 'deleted', label: '回收站' }], 'current');
    const statistics = el('div', { className: 'control-stats', 'aria-label': '账号概况' });
    const list = el('div', { className: 'control-account-list', 'aria-label': '内部账号列表' });
    const inspector = el('section', { className: 'control-inspector', 'aria-label': '账号与权限设置' }, empty('选择一个账号', '在这里调整账号状态、系统角色和项目访问权限。'));
    const errors = el('div');
    const pagination = el('div', { className: 'pagination' });
    const form = el('form', { className: 'control-filters' }, search.wrapper, role.wrapper, state.wrapper,
        button('筛选', null, { type: 'submit', glyph: 'search' }));
    const root = el('div', { className: 'control-root' },
        el('div', { className: 'control-intro' }, el('div', {}, el('div', { className: 'control-eyebrow', text: 'ADMINISTRATION' }), el('h3', { text: '账号与权限，一处管理。' }), el('p', { className: 'muted', text: '管理谁能登录，以及他们能进入哪些项目。' })),
            el('div', { className: 'actions' }, onAudit && button('只读审计', onAudit, { glyph: 'shield' }), button('新增账号', () => createAccount(), { className: 'button primary', glyph: 'plus' }))),
        statistics, errors,
        el('div', { className: 'control-layout' }, el('section', { className: 'control-directory' }, form, list, pagination), inspector));
    const view = panel('控制面板', root, { wide: true, subtitle: 'AI七嫂·员工专属版 · 仅系统管理员可用' });
    view.dialog.classList.add('control-dashboard');
    view.dialog.addEventListener('close', () => { directoryOwner.dispose(); editorOwner.dispose(); reading?.abort(); permissionReading?.abort(); onClose?.(); }, { once: true });
    const connected = () => view.dialog.isConnected;
    const ignore = error => error.name === 'AbortError' || error.code === 'STALE_RESPONSE';
    const inspect = (...children) => inspector.replaceChildren(el('div', { className: 'control-inspector-content' }, ...children));

    function renderStats(summary = {}) {
        statistics.replaceChildren(...[
            ['全部账号', summary.totalUsers ?? 0, '含已停用账号与回收站'],
            ['已启用', summary.activeUsers ?? 0, '可以使用密码登录'],
            ['已停用', summary.disabledUsers ?? 0, '暂时收回登录权限'],
            ['系统管理员', summary.systemAdmins ?? 0, '管理账号与全局审计'],
        ].map(([label, value, detail]) => el('div', { className: 'control-stat' }, el('span', { text: label }), el('strong', { text: value }), el('small', { text: detail }))));
    }

    function renderList() {
        list.replaceChildren(...(accounts.length ? accounts.map(account => el('button', {
            type: 'button', className: 'control-account-row' + (selectedId === account.id ? ' selected' : ''),
            'aria-pressed': String(selectedId === account.id), onclick: () => selectAccount(account),
        }, el('span', { className: 'initials', text: account.displayName.slice(0, 1) }),
        el('div', { className: 'control-account-identity' }, el('strong', { text: account.displayName + (account.id === user.id ? '（你）' : '') }), el('small', { text: account.username + ' · ' + roleName(account.systemRole) })),
        badge(stateName(account), account.deletedAt ? 'error' : account.active ? 'accent' : '')))
            : [empty('没有符合条件的账号', '调整筛选条件，或添加一位内部成员。')]));
        pagination.replaceChildren(button('上一页', () => { page--; resetSelection(); load(); }, { disabled: page === 1 }),
            el('span', { text: '第 ' + page + ' 页' }), button('下一页', () => { page++; resetSelection(); load(); }, { disabled: !hasMore }));
    }

    async function load({ preserveInspector = false } = {}) {
        reading?.abort(); reading = new AbortController();
        const current = directoryOwner.advance();
        const requestedSelection = editorOwner.capture();
        errors.replaceChildren();
        try {
            const data = await api('/api/admin/control-panel' + query({ q: search.control.value.trim(), systemRole: role.control.value, status: state.control.value, limit: 25, offset: (page - 1) * 25 }), { signal: reading.signal });
            if (!connected() || !directoryOwner.current(current)) return;
            accounts = data.users || []; projects = data.projects || []; hasMore = Boolean(data.hasMore);
            renderStats(data.summary); renderList();
            if (!preserveInspector && editorOwner.current(requestedSelection)) {
                const account = accounts.find(account => account.id === selectedId);
                if (account) selectAccount(account);
                else { selectedId = null; inspect(empty('选择一个账号', '选择成员查看账号设置与项目权限，或点击“新增账号”。')); }
            }
        } catch (error) { if (connected() && directoryOwner.current(current) && !ignore(error)) errors.replaceChildren(notice(error.message, 'error'), button('重新读取', load)); }
    }

    async function changed(message, accountId = selectedId, requestedSelection = editorOwner.capture()) {
        if (!connected()) return;
        const stillSelected = editorOwner.current(requestedSelection);
        if (stillSelected) selectedId = accountId;
        await load({ preserveInspector: !stillSelected });
        if (connected()) { if (message) toast(message); await onChanged?.(); }
    }

    function selectAccount(account) {
        editorOwner.advance(); permissionReading?.abort();
        selectedId = account.id; renderList();
        const own = account.id === user.id;
        if (account.deletedAt) {
            const restoreErrors = el('div');
            const restoreForm = el('form', { className: 'stack' },
                notice('此账号已删除，不能登录。恢复后先保持停用，你可以核对权限后再启用。'), restoreErrors,
                button('恢复账号', null, { type: 'submit', className: 'button primary', glyph: 'user' }));
            restoreForm.addEventListener('submit', event => {
                event.preventDefault(); const started = editorOwner.capture(); submitting(restoreForm, async () => {
                    await api('/api/admin/users/' + encodeURIComponent(account.id) + '/restore', { method: 'POST', body: {} });
                    if (editorOwner.current(started)) { state.control.value = 'disabled'; page = 1; }
                    await changed('账号已恢复，当前保持停用。', account.id, started);
                }, restoreErrors);
            });
            inspect(accountHeading(account), el('p', { className: 'muted', text: '删除时间：' + formatDate(account.deletedAt) }), restoreForm);
            return;
        }
        const displayName = input('显示名称', { value: account.displayName, required: true, maxlength: 80 });
        const systemRole = select('系统角色', [{ value: 'member', label: '普通成员' }, { value: 'admin', label: '系统管理员' }], account.systemRole);
        const active = el('input', { type: 'checkbox', checked: account.active, disabled: own });
        systemRole.control.disabled = own;
        const editorErrors = el('div');
        const editor = el('form', { className: 'stack-tight' }, displayName.wrapper, systemRole.wrapper,
            el('label', { className: 'check-field' }, active, el('span', { text: '允许此账号登录' })),
            el('small', { className: 'muted', text: own ? '当前账号的管理权限受保护，不能停用或撤销自己的系统管理员身份。' : '停用和角色变更会立即撤销该成员已有的登录会话。' }), editorErrors,
            button('保存账号设置', null, { type: 'submit', className: 'button primary' }));
        editor.addEventListener('submit', event => {
            event.preventDefault(); const started = editorOwner.capture(); submitting(editor, async () => {
                await api('/api/admin/users/' + encodeURIComponent(account.id), { method: 'PATCH', body: { displayName: displayName.control.value.trim(), systemRole: systemRole.control.value, active: active.checked } });
                await changed('账号设置已保存。', account.id, started);
            }, editorErrors);
        });
        const permissionHost = el('div', { className: 'stack-tight' }, empty('正在读取项目权限…'));
        inspect(accountHeading(account), editor, el('div', { className: 'divider' }),
            el('div', {}, el('h4', { text: '项目访问权限' }), el('p', { className: 'muted control-permission-hint', text: '系统角色与项目角色分别管理。只有加入项目，才会将该项目资料用于日常讨论。' })), permissionHost,
            el('div', { className: 'divider' }), el('div', { className: 'actions' },
                button('重置密码', () => resetPassword(account), { disabled: own, title: own ? '请在“账号与偏好”中修改自己的密码。' : '设置临时密码，下次登录需要改密。' }),
                button('删除账号', () => deleteAccount(account), { className: 'button danger', glyph: 'trash', disabled: own })));
        loadPermissions(account, permissionHost, editorOwner.capture());
        if (matchMedia('(max-width:820px)').matches) requestAnimationFrame(() => { if (connected()) inspector.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    }

    function accountHeading(account) {
        return el('div', { className: 'control-account-heading' }, el('span', { className: 'initials', text: account.displayName.slice(0, 1) }),
            el('div', { className: 'flex' }, el('h3', { text: account.displayName }), el('p', { className: 'muted', text: account.username + ' · ' + roleName(account.systemRole) })), badge(stateName(account), account.active && !account.deletedAt ? 'accent' : ''));
    }

    async function loadPermissions(account, target, current) {
        permissionReading = new AbortController();
        try {
            const data = await api('/api/admin/users/' + encodeURIComponent(account.id) + '/projects', { signal: permissionReading.signal });
            if (!connected() || !editorOwner.current(current) || !target.isConnected) return;
            const values = data.projects || projects;
            target.replaceChildren(...(values.length ? values.map(project => {
                const canAssign = project.canAssign ?? (!project.archived && account.active);
                const canRevoke = project.canRevoke ?? (!project.archived && Boolean(project.role));
                const options = select('「' + project.name + '」的权限', [{ value: '', label: '无项目权限' }, { value: 'member', label: '项目成员' }, { value: 'admin', label: '项目管理员' }], project.role || '');
                options.control.disabled = !canAssign && !canRevoke;
                if (!canAssign) for (const option of options.control.options) if (option.value && option.value !== project.role) option.disabled = true;
                const messages = el('div');
                const row = el('form', { className: 'control-project-row' }, el('div', { className: 'control-project-name' }, el('strong', { text: project.name }), project.archived && badge('已归档')),
                    options.wrapper, messages, button(!canAssign && canRevoke ? '撤销权限' : '保存权限', null, { type: 'submit', className: 'button small', disabled: !canAssign && !canRevoke }));
                row.addEventListener('submit', event => {
                    event.preventDefault(); const started = editorOwner.capture(); submitting(row, async () => {
                        const nextRole = options.control.value;
                        if (nextRole === (project.role || '')) return;
                        const endpoint = '/api/admin/users/' + encodeURIComponent(account.id) + '/projects/' + encodeURIComponent(project.id);
                        await api(endpoint, { method: nextRole ? 'PUT' : 'DELETE', ...(nextRole ? { body: { role: nextRole } } : {}) });
                        await changed('项目权限已更新。', account.id, started);
                    }, messages);
                });
                return row;
            }) : [empty('还没有项目', '先在工作空间创建项目，再在这里分配访问权限。')]));
            if (!account.active) target.prepend(notice('账号已停用，可先撤销已有项目权限；重新启用后可授予新权限。'));
        } catch (error) { if (connected() && editorOwner.current(current) && !ignore(error)) target.replaceChildren(notice(error.message, 'error')); }
    }

    function createAccount() {
        editorOwner.advance(); selectedId = null; permissionReading?.abort(); renderList();
        const username = input('登录账号', { required: true, minlength: 3, maxlength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', autocomplete: 'off', placeholder: '例如：zhangsan', hint: '3–64 位字母、数字、下划线、短横线或点。' });
        const name = input('显示名称', { required: true, maxlength: 80, placeholder: '成员姓名' });
        const password = input('初始密码', { type: 'password', required: true, minlength: 6, maxlength: 256, autocomplete: 'new-password', hint: '至少 6 位，可用纯数字；成员首次登录需修改。' });
        const newRole = select('系统角色', [{ value: 'member', label: '普通成员' }, { value: 'admin', label: '系统管理员' }]);
        const messages = el('div');
        const form = el('form', { className: 'stack' }, username.wrapper, name.wrapper, password.wrapper, newRole.wrapper,
            notice('普通成员管理自己的讨论与记忆；系统管理员还可管理账号、分配项目权限，并通过只读审计查看全局数据。'), messages,
            el('div', { className: 'actions' }, button('取消', () => { inspect(empty('选择一个账号', '从左侧选择成员，或继续添加账号。')); }), button('创建账号', null, { type: 'submit', className: 'button primary', glyph: 'plus' })));
        form.addEventListener('submit', event => {
            event.preventDefault(); const started = editorOwner.capture(); submitting(form, async () => {
                const data = await api('/api/admin/users', { method: 'POST', body: { username: username.control.value.trim(), displayName: name.control.value.trim(), password: password.control.value, systemRole: newRole.control.value } });
                password.control.value = '';
                if (editorOwner.current(started)) { search.control.value = data.user.username; state.control.value = 'current'; role.control.value = ''; page = 1; }
                await changed('账号已创建，可继续分配项目权限。', data.user.id, started);
            }, messages);
        });
        inspect(el('h3', { text: '新增内部账号' }), form); username.control.focus();
    }

    function resetPassword(account) {
        editorOwner.advance(); permissionReading?.abort();
        const password = input('新的临时密码', { type: 'password', required: true, minlength: 6, maxlength: 256, autocomplete: 'new-password', hint: '至少 6 位，可用纯数字。已有会话会失效，下次登录必须改密。' });
        const messages = el('div');
        const form = el('form', { className: 'stack' }, password.wrapper, messages,
            el('div', { className: 'actions' }, button('返回账号设置', () => selectAccount(account)), button('重置密码', null, { type: 'submit', className: 'button primary' })));
        form.addEventListener('submit', event => { event.preventDefault(); const started = editorOwner.capture(); submitting(form, async () => {
            await api('/api/admin/users/' + encodeURIComponent(account.id) + '/reset-password', { method: 'POST', body: { password: password.control.value } });
            password.control.value = ''; await changed('临时密码已设置。', account.id, started);
        }, messages); });
        inspect(accountHeading(account), el('h3', { text: '重置登录密码' }), form); password.control.focus();
    }

    function deleteAccount(account) {
        editorOwner.advance(); permissionReading?.abort();
        const messages = el('div');
        const form = el('form', { className: 'stack' }, notice('删除后立即禁止登录并撤销现有会话。聊天、记忆和审计记录保留，账号可从回收站恢复。', 'warning'),
            el('p', { className: 'muted', text: '如果该成员是某个有效项目的唯一管理员，请先移交项目权限。' }), messages,
            el('div', { className: 'actions' }, button('取消', () => selectAccount(account)), button('确认删除账号', null, { type: 'submit', className: 'button danger', glyph: 'trash' })));
        form.addEventListener('submit', event => { event.preventDefault(); const started = editorOwner.capture(); submitting(form, async () => {
            await api('/api/admin/users/' + encodeURIComponent(account.id), { method: 'DELETE' });
            await changed('账号已移入回收站。', null, started);
        }, messages); });
        inspect(accountHeading(account), el('h3', { text: '删除这个账号？' }), form);
    }

    function resetSelection() {
        editorOwner.advance(); selectedId = null; permissionReading?.abort();
        inspect(empty('选择一个账号', '从列表中选择成员，或点击“新增账号”。'));
    }
    function applyFilters() { page = 1; resetSelection(); load(); }
    form.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
    role.control.addEventListener('change', applyFilters);
    state.control.addEventListener('change', applyFilters);
    renderStats(); list.replaceChildren(empty('正在读取账号…')); load();
    return view;
}
