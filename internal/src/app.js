import { api, setSession, getSession, onUnauthorized, onSetupRequired, query } from './api.js';
import { loginScreen, passwordScreen, accountPanel } from './account.js';
import { createProjectPanel, openProjectPanel } from './projects.js';
import { openMemoryPanel } from './memories.js';
import { openAuditPanel } from './admin.js';
import { openControlPanel } from './control-panel.js';
import { createChatView, clearDrafts, activateDraftOwner, followRun } from './chat.js';
import { el, button, icon, input, panel, closePanel, notice, empty, badge, submitting, confirmAction, toast } from './ui.js';

const host = document.getElementById('app');
let user;
let projects = [];
let project = null;
let conversation = null;
let conversations = [];
let chat;
let follower;
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
let scopeVersion = 0;
let selectionVersion = 0;
let sessionVersion = 0;
let posting = false;
let openingSetup = false;

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
    sessionVersion++; scopeVersion++; selectionVersion++;
    follower?.dispose(); follower = null;
    chat?.dispose(); chat = null;
    closePanel();
    projects = []; project = null; conversations = []; conversation = null; posting = false;
    host.replaceChildren();
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
    setSession(data); user = data.user;
    if (user.mustChangePassword) { host.replaceChildren(passwordScreen(user, acceptSession, logout)); return; }
    buildShell();
    await refreshProjects();
    if (user) await selectProject(null);
    if (user && /^\/admin\/?$/.test(location.pathname)) controlPanel();
}

async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch (error) { if (error.status !== 401) { toast(error.message, 'error'); return; } }
    showLogin();
}

function account() {
    accountPanel(user, { onLogout: logout, onUserChanged(value) {
        user = value;
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
            const previousProject = project?.id;
            const session = await api('/api/auth/me');
            user = session.user; setSession(session);
            accountName.textContent = user.displayName;
            chat?.setUser(user);
            await refreshProjects();
            if (previousProject && !projects.some(item => item.id === previousProject)) await selectProject(null);
            else if (previousProject) {
                const updated = projects.find(item => item.id === previousProject);
                if (updated?.role !== project?.role) await selectProject(updated);
                else { project = updated; updateHeading(); }
            }
        },
    });
}

function openMemories(memory) {
    openMemoryPanel({ user, project, conversationId: conversation?.id,
        initialScope: memory?.scope, focusId: memory?.id,
        onSource: async (id, messageId) => {
            try {
                const data = await api('/api/conversations/' + encodeURIComponent(id));
                const targetProject = data.conversation.projectId ? projects.find(item => item.id === data.conversation.projectId) : null;
                if (data.conversation.projectId && !targetProject) throw new Error('你已不在来源项目中。');
                if (project?.id !== targetProject?.id) await selectProject(targetProject);
                await selectConversation(id, data);
                if (messageId) requestAnimationFrame(() => document.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
            } catch (error) { if (error.code !== 'STALE_RESPONSE') toast(error.message, 'error'); }
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
        el('section', { className: 'sidebar-section' }, el('div', { className: 'section-label row-between' }, el('span', { text: '项目空间' }), button('', () => createProjectPanel(async value => { await refreshProjects(); await selectProject(projects.find(item => item.id === value.id) || value); }), { className: 'icon-button small', glyph: 'plus', name: '创建项目空间' })), projectList),
        el('section', { className: 'sidebar-section grow' }, el('div', { className: 'section-label', text: '最近讨论' }), conversationList),
            el('footer', { className: 'sidebar-footer' }, user.systemRole === 'admin' && el('div', { className: 'sidebar-nav' }, button('控制面板', controlPanel, { className: 'nav-item', glyph: 'settings' }), button('全局只读审计', () => openAuditPanel(), { className: 'nav-item', glyph: 'shield' })),
            el('button', { className: 'account-button', type: 'button', onclick: account }, el('span', { className: 'initials', text: user.displayName.slice(0, 1) }), el('div', { className: 'account-meta' }, accountName, accountRole), icon('settings', 17))));
    title = el('h1', { className: 'header-title', text: '个人空间' });
    subtitle = el('div', { className: 'header-subtitle' });
    conversationActions = button('', openConversationSettings, { className: 'icon-button mobile-hide', glyph: 'edit', name: '对话设置', hidden: true });
    projectDetails = button('项目信息', () => openProjectPanel({ user, project, onChanged: projectChanged }), { className: 'button', glyph: 'folder', hidden: true });
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
    follower?.dispose(); follower = null;
    chat?.dispose();
    const previous = shell.querySelector('.messages-scroll');
    previous?.remove(); shell.querySelector('.composer-region')?.remove();
    chat = createChatView({ user, project, onSend: sendMessage, onStop: stopRun,
        onMemoryChange: async (value, enabled) => {
            const data = await api('/api/conversations/' + encodeURIComponent(value.id), { method: 'PATCH', body: { memoryEnabled: enabled } });
            conversation = data.conversation; return conversation;
        }, onMemory: openMemories });
    shell.querySelector('.workspace').append(chat.scroller, chat.region);
    chat.setConversation(null);
    connection.hidden = true;
}

function closeSidebar() { shell?.classList.remove('sidebar-open'); }

async function refreshProjects() {
    const started = sessionVersion;
    try {
        const data = await api('/api/projects');
        if (!user || started !== sessionVersion) return;
        projects = data.projects || [];
        renderProjects();
    } catch (error) {
        if (user && started === sessionVersion && error.code !== 'STALE_RESPONSE') projectList.replaceChildren(el('p', { className: 'sidebar-empty', text: error.message }), button('重新读取项目', refreshProjects, { className: 'button small' }));
    }
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
    if (!user) return;
    const current = ++scopeVersion;
    selectionVersion++;
    project = value;
    conversation = null; conversations = [];
    closeSidebar(); makeChat(); renderProjects(); updateHeading();
    conversationList.replaceChildren(el('p', { className: 'sidebar-empty', text: '正在读取讨论…' }));
    try {
        const data = await api('/api/conversations' + query({ projectId: value?.id }));
        if (current !== scopeVersion) return;
        conversations = data.conversations || []; renderConversations();
    } catch (error) {
        if (current !== scopeVersion || error.code === 'STALE_RESPONSE') return;
        conversationList.replaceChildren(el('p', { className: 'sidebar-empty', text: error.message }), button('重新读取', () => selectProject(value), { className: 'button small' }));
    }
}

function renderConversations() {
    conversationList.replaceChildren(...(conversations.length ? conversations.map(item => el('button', { type: 'button', className: 'nav-item' + (conversation?.id === item.id ? ' selected' : ''), onclick: () => selectConversation(item.id), title: item.title },
        icon(item.readOnly ? 'lock' : 'chat', 16), el('span', { className: 'flex', text: item.title || '新的讨论' }), item.readOnly && badge(item.ownerName || '只读'))) : [el('p', { className: 'sidebar-empty', text: project?.archived ? '此归档项目没有讨论。' : '新讨论会出现在这里。' })]));
}

async function selectConversation(id, preloaded) {
    const current = ++selectionVersion;
    const scope = scopeVersion;
    closeSidebar(); follower?.dispose(); follower = null;
    try {
        const data = preloaded || await api('/api/conversations/' + encodeURIComponent(id));
        if (current !== selectionVersion || scope !== scopeVersion) return;
        conversation = data.conversation;
        chat.setConversation(conversation, data.messages || [], data.run);
        renderConversations(); updateHeading();
        if (data.run && ['queued', 'running'].includes(data.run.state)) attachRun(data.run);
    } catch (error) {
        if (current !== selectionVersion || error.code === 'STALE_RESPONSE') return;
        chat.showError(error.message);
    }
}

function newConversation() {
    if (posting) return;
    selectionVersion++;
    follower?.dispose(); follower = null;
    conversation = null; connection.hidden = true;
    chat.setConversation(null); renderConversations(); updateHeading(); closeSidebar();
    if (!project?.archived) chat.focus();
}

async function refreshConversations() {
    const current = scopeVersion;
    const data = await api('/api/conversations' + query({ projectId: project?.id }));
    if (current !== scopeVersion) return;
    conversations = data.conversations || []; renderConversations();
}

async function sendMessage(content, memoryEnabled) {
    if (posting) return;
    posting = true;
    const current = selectionVersion;
    const scope = scopeVersion;
    const activeChat = chat;
    let target = conversation;
    try {
        if (!target) {
            const data = await api('/api/conversations', { method: 'POST', body: { ...(project ? { projectId: project.id } : {}), title: content.slice(0, 42), memoryEnabled } });
            target = data.conversation;
            if (current !== selectionVersion || scope !== scopeVersion) return;
            conversation = target;
            conversations.unshift(target); renderConversations(); updateHeading();
        }
        const requestId = crypto.randomUUID();
        let data;
        try {
            data = await api('/api/chat/runs', { method: 'POST', body: { conversationId: target.id, message: content, requestId } });
        } catch (error) {
            if (error.code !== 'NETWORK_ERROR') throw error;
            const recovered = await api('/api/conversations/' + encodeURIComponent(target.id));
            if (recovered.run?.requestId === requestId) data = { run: recovered.run };
            else throw new Error('发送结果尚未确认，草稿已保留。请重新打开此对话核对，避免重复发送。');
        }
        if (current !== selectionVersion || scope !== scopeVersion) return;
        activeChat.clearDraft();
        const detail = await api('/api/conversations/' + encodeURIComponent(target.id));
        if (current !== selectionVersion || scope !== scopeVersion) return;
        conversation = detail.conversation;
        activeChat.setConversation(conversation, detail.messages || [], detail.run || data.run);
        attachRun(detail.run || data.run);
        refreshConversations().catch(() => {});
    } finally { posting = false; }
}

function attachRun(run) {
    if (!run || !['queued', 'running'].includes(run.state)) { chat.setRun(null); return; }
    follower?.dispose();
    const current = selectionVersion;
    const activeChat = chat;
    activeChat.setRun(run);
    follower = followRun(run.id, {
        onUpdate(message) { if (current === selectionVersion) activeChat.upsert(message); },
        onState(value) { if (current === selectionVersion) activeChat.setRun(value); },
        onConnection(text) { if (current === selectionVersion) { connection.textContent = text; connection.hidden = !text; } },
        onFinished(value) {
            if (current !== selectionVersion) return;
            connection.hidden = true;
            if (value.state === 'failed' || value.state === 'interrupted') activeChat.showError('本次生成未完成，已保存收到的内容。你可以发送新消息继续。');
            refreshConversations().catch(() => {});
        },
        onDenied(error) {
            if (current !== selectionVersion || error.status === 401) return;
            refreshProjects().then(() => { if (current === selectionVersion) selectProject(null); });
        },
    });
}

async function stopRun(run) {
    const current = selectionVersion;
    try {
        const data = await api('/api/chat/runs/' + encodeURIComponent(run.id) + '/stop', { method: 'POST' });
        if (current !== selectionVersion) return;
        if (data.message) chat.upsert(data.message);
        if (data.run) chat.setRun(data.run);
        follower?.sync();
    } catch (error) { if (current === selectionVersion && error.code !== 'STALE_RESPONSE') chat.showError(error.message); }
}

function openConversationSettings() {
    if (!conversation || conversation.readOnly) return;
    const target = conversation;
    const name = input('讨论名称', { value: target.title || '', required: true, maxlength: 120 });
    const errors = el('div');
    const form = el('form', { className: 'stack' }, name.wrapper, errors, button('保存名称', null, { type: 'submit', className: 'button primary' }),
        button('删除这段讨论', async () => {
            const accepted = await confirmAction('删除这段讨论？', '删除后将不能从聊天列表打开这段讨论。来源记忆按服务端规则停止使用。', '删除讨论');
            if (!accepted) { if (conversation?.id === target.id) openConversationSettings(); return; }
            try {
                await api('/api/conversations/' + encodeURIComponent(target.id), { method: 'DELETE' });
                if (conversation?.id === target.id) newConversation();
                await refreshConversations(); toast('讨论已删除。');
            } catch (error) { toast(error.message, 'error'); }
        }, { className: 'button danger', glyph: 'trash' }));
    const view = panel('对话设置', form);
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const data = await api('/api/conversations/' + encodeURIComponent(target.id), { method: 'PATCH', body: { title: name.control.value.trim() } });
            if (conversation?.id === target.id) { conversation = data.conversation; updateHeading(); }
            view.close(); await refreshConversations();
        }, errors);
    });
}

async function projectChanged() {
    const id = project?.id;
    const conversationId = conversation?.id;
    await refreshProjects();
    if (!user) return;
    const updated = projects.find(item => item.id === id);
    if (!updated) { closePanel(); await selectProject(null); return; }
    await selectProject(updated);
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
