import { api, setSession, getSession, onUnauthorized, onSetupRequired } from './api.js';
import { loginScreen, passwordScreen, accountPanel } from './account.js';
import { createProjectPanel, openProjectPanel } from './projects.js';
import { openMemoryPanel } from './memories.js';
import { openAuditPanel } from './admin.js';
import { openControlPanel } from './control-panel.js';
import { createChatView, clearDrafts, activateDraftOwner, followRun, drafts } from './chat.js';
import { createWorkspaceController } from './workspace-controller.js';
import { el, button, icon, input, panel, closePanel, notice, empty, badge, submitting, confirmAction, toast } from './ui.js';

const host = document.getElementById('app');
let user;
let projects = [];
let project = null;
let conversation = null;
let conversations = [];
let chat;
let shell;
let title;
let subtitle;
let projectList;
let conversationList;
let connection;
let conversationActions;
let accountName;
let accountRole;
let projectDetails;
let openingSetup = false;

const workspace = createWorkspaceController({ api, observeRun: followRun, drafts,
    onState(state) {
        ({ user, project, projects, conversation, conversations } = state);
        if (shell?.isConnected && user) { renderProjects(); renderConversations(); updateHeading(); }
    },
    onSelection() { if (shell?.isConnected) { closeSidebar(); makeChat(); } },
    onConversation(data) { chat?.setConversation(data.conversation, data.messages || [], data.run); },
    onMessage(message) { chat?.upsert(message); },
    onRun(run) { chat?.setRun(run); },
    onBusy(busy) { chat?.setBusy(busy); },
    onDraftCleared(draft) { chat?.confirmDraft(draft); },
    onConnection(text) { if (connection) { connection.textContent = text; connection.hidden = !text; } },
    onError(error, area) {
        if (area === 'projects') projectList?.replaceChildren(el('p', { className: 'sidebar-empty', text: error.message }), button('重新读取项目', refreshProjects, { className: 'button small' }));
        else if (area === 'conversations') conversationList?.replaceChildren(el('p', { className: 'sidebar-empty', text: error.message }), button('重新读取', refreshConversations, { className: 'button small' }));
        else chat?.showError(error.message);
    },
});

function preferredTheme() {
    try { const stored = localStorage.getItem('weizhiyu-internal-theme'); if (['light', 'dark'].includes(stored)) return stored; } catch {}
    return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#15171c' : '#f8f9fb');
    for (const control of document.querySelectorAll('.theme-toggle')) control.replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'));
}
applyTheme(preferredTheme());
function changeTheme() {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem('weizhiyu-internal-theme', theme); } catch {}
}
function viewport() {
    const visible = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', Math.round(visible?.height || innerHeight) + 'px');
    document.documentElement.style.setProperty('--app-offset-top', Math.round(visible?.offsetTop || 0) + 'px');
    window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', viewport);
window.visualViewport?.addEventListener('scroll', viewport);
window.addEventListener('resize', viewport);
viewport();

function clearWorkspace() {
    workspace.clearSession();
    chat?.dispose(); chat = null;
    closePanel();
    host.replaceChildren();
    shell = null;
}
function showLogin(message = '') {
    clearWorkspace(); clearDrafts(); setSession(null); user = null;
    host.replaceChildren(loginScreen(acceptSession, message));
}
onUnauthorized(() => showLogin('登录已失效，请重新登录。'));
onSetupRequired(async () => {
    if (openingSetup) return;
    openingSetup = true;
    try { await acceptSession(await api('/api/auth/me')); }
    catch (error) { if (error.code !== 'STALE_RESPONSE') toast(error.message, 'error'); }
    finally { openingSetup = false; }
});

async function acceptSession(data) {
    clearWorkspace();
    activateDraftOwner(data.user.id);
    setSession(data); workspace.setUser(data.user);
    if (user.mustChangePassword) { host.replaceChildren(passwordScreen(user, acceptSession, logout)); return; }
    buildShell();
    const started = workspace.capture();
    await refreshProjects();
    if (!workspace.current(started)) return;
    if (!await selectProject(null)) return;
    if (user && /^\/admin\/?$/.test(location.pathname)) controlPanel();
}

async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch (error) { if (error.status !== 401) { toast(error.message, 'error'); return; } }
    showLogin();
}

function account() {
    accountPanel(user, { onLogout: logout, onUserChanged(value) {
        workspace.setUser(value);
        const current = getSession();
        if (current) setSession({ ...current, user: value });
        accountName.textContent = value.displayName;
        chat?.setUser(value);
        if (conversation) selectConversation(conversation.id);
    } });
}

function controlPanel() {
    closeSidebar();
    if (user?.systemRole !== 'admin') {
        history.replaceState(null, '', '/');
        toast('控制面板仅对系统管理员开放。', 'error');
        return;
    }
    history.replaceState(null, '', '/admin');
    openControlPanel(user, {
        onClose() { if (/^\/admin\/?$/.test(location.pathname)) history.replaceState(null, '', '/'); },
        onAudit: () => openAuditPanel(),
        onChanged: async () => {
            const started = workspace.capture();
            const session = await api('/api/auth/me');
            if (!workspace.current(started, 'session')) return;
            workspace.setUser(session.user); setSession(session);
            accountName.textContent = user.displayName;
            accountRole.textContent = user.systemRole === 'admin' ? '系统管理员' : '内部成员';
            chat?.setUser(user);
            await refreshProjects();
        },
    });
}

function createProject() {
    const started = workspace.capture();
    createProjectPanel(async value => {
        if (!workspace.current(started, 'session')) return;
        await refreshProjects();
        if (workspace.current(started)) await selectProject(projects.find(item => item.id === value.id) || value);
    });
}

function projectInformation() {
    const started = workspace.capture();
    openProjectPanel({ user, project, onChanged: () => projectChanged(started) });
}

function openMemories(memory) {
    openMemoryPanel({ user, project, conversationId: conversation?.id,
        initialScope: memory?.scope, focusId: memory?.id,
        onSource: async (id, messageId) => {
            const started = workspace.capture();
            try {
                const data = await api('/api/conversations/' + encodeURIComponent(id));
                if (!workspace.current(started)) return;
                const targetProject = data.conversation.projectId ? projects.find(item => item.id === data.conversation.projectId) : null;
                if (data.conversation.projectId && !targetProject) throw new Error('你已不在来源项目中。');
                if (project?.id !== targetProject?.id && !await selectProject(targetProject)) return;
                if (!await selectConversation(id, data)) return;
                const selected = workspace.capture();
                if (messageId) requestAnimationFrame(() => { if (workspace.current(selected)) document.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
            } catch (error) { if (workspace.current(started) && error.code !== 'STALE_RESPONSE') toast(error.message, 'error'); }
        } });
}

function buildShell() {
    projectList = el('div', { className: 'nav-list project-list' });
    conversationList = el('div', { className: 'nav-list' });
    accountName = el('strong', { text: user.displayName });
    accountRole = el('small', { text: user.systemRole === 'admin' ? '系统管理员' : '内部成员' });
    const sidebar = el('aside', { className: 'app-sidebar', 'aria-label': '工作空间导航' },
        el('div', { className: 'sidebar-brand-row' }, el('img', { className: 'brand-avatar', src: '/static/img/avatar-192.png', alt: 'AI七嫂·员工专属版' }),
            el('div', { className: 'brand-wordmark' }, el('strong', { text: 'AI七嫂·员工专属版' }), el('small', { text: '薇之雨 · 内部工作空间' })), button('', closeSidebar, { className: 'icon-button sidebar-mobile-close', glyph: 'close', name: '关闭导航' })),
        button('开启新讨论', () => newConversation(), { className: 'button sidebar-new', glyph: 'plus' }),
        el('nav', { className: 'sidebar-nav' }, button('个人空间', () => selectProject(null), { className: 'nav-item personal-space', glyph: 'chat' }), button('记忆库', () => openMemories(), { className: 'nav-item', glyph: 'memory' })),
        el('section', { className: 'sidebar-section' }, el('div', { className: 'section-label row-between' }, el('span', { text: '项目空间' }), button('', createProject, { className: 'icon-button small', glyph: 'plus', name: '创建项目空间' })), projectList),
        el('section', { className: 'sidebar-section grow' }, el('div', { className: 'section-label', text: '最近讨论' }), conversationList),
            el('footer', { className: 'sidebar-footer' }, user.systemRole === 'admin' && el('div', { className: 'sidebar-nav' }, button('控制面板', controlPanel, { className: 'nav-item', glyph: 'settings' }), button('全局只读审计', () => openAuditPanel(), { className: 'nav-item', glyph: 'shield' })),
            el('button', { className: 'account-button', type: 'button', onclick: account }, el('span', { className: 'initials', text: user.displayName.slice(0, 1) }), el('div', { className: 'account-meta' }, accountName, accountRole), icon('settings', 17))));
    title = el('h1', { className: 'header-title', text: '个人空间' });
    subtitle = el('div', { className: 'header-subtitle' });
    conversationActions = button('', openConversationSettings, { className: 'icon-button', glyph: 'edit', name: '对话设置', hidden: true });
    projectDetails = button('项目信息', projectInformation, { className: 'button', glyph: 'folder', hidden: true });
    const heading = el('div', { className: 'workspace-heading' }, button('', () => { shell.classList.add('sidebar-open'); sidebar.querySelector('button')?.focus(); }, { className: 'icon-button mobile-menu', glyph: 'menu', name: '打开导航' }), el('div', { className: 'flex' }, title, subtitle));
    const header = el('header', { className: 'workspace-header' }, heading,
        el('div', { className: 'header-actions' }, conversationActions, projectDetails, button('记忆库', () => openMemories(), { className: 'button', glyph: 'memory' }), button('', changeTheme, { className: 'icon-button theme-toggle', glyph: document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun', name: '切换明暗主题' })));
    connection = el('div', { className: 'connection-banner', hidden: true, role: 'status' });
    const workspace = el('main', { className: 'workspace' }, header, connection);
    shell = el('div', { className: 'shell' }, el('button', { type: 'button', className: 'sidebar-overlay', onclick: closeSidebar, 'aria-label': '关闭导航' }), sidebar, workspace);
    shell.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
    host.replaceChildren(shell);
    makeChat();
}

function makeChat() {
    chat?.dispose();
    const previous = shell.querySelector('.messages-scroll');
    previous?.remove(); shell.querySelector('.composer-region')?.remove();
    const selection = workspace.capture();
    chat = createChatView({ user, project, onSend: command => workspace.send({ ...command, selection }), onStop: run => workspace.stop(run), onMemory: openMemories });
    shell.querySelector('.workspace').append(chat.scroller, chat.region);
    chat.setConversation(null);
    connection.hidden = true;
}

function closeSidebar() { shell?.classList.remove('sidebar-open'); }

async function refreshProjects() {
    return workspace.refreshProjects();
}

function renderProjects() {
    if (!projectList) return;
    projectList.replaceChildren(...(projects.length ? projects.map(item => el('button', { type: 'button', className: 'nav-item' + (project?.id === item.id ? ' selected' : ''), onclick: () => selectProject(item), title: item.name },
        icon('folder', 17), el('span', { className: 'flex', text: item.name }), item.archived && badge('归档'))) : [el('p', { className: 'sidebar-empty', text: '还没有项目空间。创建一个，把相关讨论与背景放在一起。' })]));
    shell?.querySelector('.personal-space')?.classList.toggle('selected', !project);
}

function updateHeading() {
    title.textContent = conversation?.title || project?.name || '个人空间';
    subtitle.replaceChildren(icon('shield'), el('span', { text: project ? (project.role === 'admin' ? '项目管理员可查看本项目全部聊天' : '本项目管理员可查看此聊天') + ' · 系统管理员可审计' : '个人聊天 · 系统管理员可审计' }));
    projectDetails.hidden = !project;
    conversationActions.hidden = !conversation || conversation.readOnly || Boolean(project?.archived);
}

async function selectProject(value) {
    return workspace.selectProject(value);
}

function renderConversations() {
    conversationList.replaceChildren(...(conversations.length ? conversations.map(item => el('button', { type: 'button', className: 'nav-item' + (conversation?.id === item.id ? ' selected' : ''), onclick: () => selectConversation(item.id), title: item.title },
        icon(item.readOnly ? 'lock' : 'chat', 16), el('span', { className: 'flex', text: item.title || '新的讨论' }), item.readOnly && badge(item.ownerName || '只读'))) : [el('p', { className: 'sidebar-empty', text: project?.archived ? '此归档项目没有讨论。' : '新讨论会出现在这里。' })]));
}

async function selectConversation(id, preloaded) {
    return workspace.selectConversation(id, preloaded);
}

function newConversation() {
    workspace.newConversation();
    if (!project?.archived) chat.focus();
}

async function refreshConversations() {
    return workspace.refreshConversations();
}

function openConversationSettings() {
    if (!conversation || conversation.readOnly) return;
    const target = conversation;
    const started = workspace.capture();
    const name = input('讨论名称', { value: target.title || '', required: true, maxlength: 120 });
    const errors = el('div');
    const form = el('form', { className: 'stack' }, name.wrapper, errors, button('保存名称', null, { type: 'submit', className: 'button primary' }),
        button('删除这段讨论', async () => {
            const accepted = await confirmAction('删除这段讨论？', '删除后将不能从聊天列表打开这段讨论。来源记忆按服务端规则停止使用。', '删除讨论');
            if (!workspace.current(started)) return;
            if (!accepted) { if (conversation?.id === target.id) openConversationSettings(); return; }
            try {
                await api('/api/conversations/' + encodeURIComponent(target.id), { method: 'DELETE' });
                if (!workspace.current(started)) return;
                if (conversation?.id === target.id) newConversation();
                await refreshConversations();
                if (workspace.current(started, 'session')) toast('讨论已删除。');
            } catch (error) { if (workspace.current(started)) toast(error.message, 'error'); }
        }, { className: 'button danger', glyph: 'trash' }));
    const view = panel('对话设置', form);
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const data = await api('/api/conversations/' + encodeURIComponent(target.id), { method: 'PATCH', body: { title: name.control.value.trim() } });
            if (!workspace.current(started)) return;
            workspace.updateConversation(data.conversation, started);
            view.close(); await refreshConversations();
        }, errors);
    });
}

async function projectChanged(started = workspace.capture()) {
    if (!workspace.current(started, 'session')) return;
    const id = started.projectId;
    const conversationId = started.conversationId;
    await refreshProjects();
    if (!workspace.current(started)) return;
    const updated = projects.find(item => item.id === id);
    if (!updated) { closePanel(); await selectProject(null); return; }
    if (!await selectProject(updated)) return;
    if (conversationId) await selectConversation(conversationId);
}

async function boot() {
    try { await acceptSession(await api('/api/auth/me')); }
    catch (error) {
        if (error.status === 401) showLogin();
        else host.replaceChildren(el('main', { className: 'boot-screen' }, icon('shield', 32), notice(error.message, 'error'), button('重新连接', boot)));
    }
}
boot();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
