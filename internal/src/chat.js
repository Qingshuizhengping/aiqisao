import { renderMarkdown } from '../../optimized/src/markdown.js';
import { api, subscribeRun } from './api.js';
import { openKnowledgeFile } from './knowledge.js';
import { el, button, icon, notice, badge, toast, formatDate } from './ui.js';

const draftPrefix = 'weizhiyu-internal-draft:';
const terminal = new Set(['completed', 'stopped', 'failed', 'interrupted']);
const memoryNames = { personal: '个人记忆', project_private: '项目私有', project_shared: '项目共享' };

export function clearDrafts() {
    try {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
            const key = sessionStorage.key(index);
            if (key?.startsWith(draftPrefix)) sessionStorage.removeItem(key);
        }
        sessionStorage.removeItem('weizhiyu-internal-draft-owner');
    } catch {}
}

export function activateDraftOwner(userId) {
    try {
        const previous = sessionStorage.getItem('weizhiyu-internal-draft-owner');
        if (previous && previous !== userId) clearDrafts();
        sessionStorage.setItem('weizhiyu-internal-draft-owner', userId);
    } catch {}
}

function draftKey(userId, conversationId, projectId) {
    return draftPrefix + userId + ':' + (conversationId || 'new-' + (projectId || 'personal'));
}

export function messageView(message, { onMemory, audit = false } = {}) {
    const body = el('div', { className: 'message-body' });
    const tools = el('div', { className: 'message-tools' });
    const column = el('div', { className: 'message-column' },
        message.role !== 'user' && el('div', { className: 'message-label', text: 'AI七嫂·员工专属版' }), body, tools);
    const element = el('article', { className: 'message ' + message.role, 'data-message-id': message.id },
        message.role !== 'user' && el('img', { className: 'message-avatar', src: '/static/img/avatar-192.png', alt: 'AI七嫂·员工专属版' }), column);
    let previousContent;
    let previousTools;
    function update(value) {
        message = value;
        if (value.content !== previousContent) {
            if (value.role === 'user') body.textContent = value.content || '';
            else body.innerHTML = renderMarkdown(value.content || '');
            previousContent = value.content;
        }
        const signature = JSON.stringify([value.status, value.metadata, Boolean(value.content)]);
        if (signature === previousTools) return;
        previousTools = signature;
        const states = { generating: '正在整理思路…', stopped: '已停止生成', failed: '生成未完成', interrupted: '生成已中断' };
        const state = states[value.status];
        const memories = value.metadata?.memories || [];
        const files = value.metadata?.files || [];
        tools.replaceChildren(...[
            value.status === 'generating' && el('span', { className: 'generating-dot', 'aria-hidden': 'true' }),
            state && el('span', { className: 'message-state', role: 'status', text: state }),
            value.content && button('复制', async () => {
                try { await navigator.clipboard.writeText(message.content); toast('回答已复制。'); }
                catch { toast('浏览器未允许复制，请长按文字选择。', 'error'); }
            }, { className: 'button quiet', glyph: 'copy' }),
            value.metadata?.memoryDegraded && badge('记忆检索暂时降级', 'warning'),
            memories.length > 0 && el('div', { className: 'memory-reference-list', 'aria-label': '本次回答引用的记忆' }, ...memories.map(memory =>
                onMemory && !audit ? button(memoryNames[memory.scope] || '引用记忆', () => onMemory(memory), { className: 'chip', glyph: 'memory', title: memory.content }) :
                    el('span', { className: 'chip', title: memory.content, text: memoryNames[memory.scope] || '引用记忆' }))),
            value.metadata?.knowledgeDegraded && badge('资料检索暂时降级', 'warning'),
            files.length > 0 && el('div', { className: 'knowledge-reference-list', 'aria-label': '本次回答参考的资料文件' }, el('span', { className: 'reference-label', text: '资料来源' }),
                ...Array.from(new Map(files.map(file => [file.fileId || file.id, file])).values()).map(file => audit
                    ? el('span', { className: 'chip', text: file.filename || file.name || '资料文件', title: file.content })
                    : button(file.filename || file.name || '资料文件', () => openKnowledgeFile({ fileId: file.fileId || file.id }), { className: 'chip', glyph: 'folder', title: file.filename || file.name || '查看资料' }))),
            audit && el('small', { text: formatDate(value.createdAt) })].filter(child => child !== false && child !== undefined && child !== null));
    }
    update(message);
    return { element, update };
}

export function createChatView({ user, project, onSend, onStop, onMemoryChange, onMemory }) {
    const list = el('div', { className: 'messages-inner' });
    const scroller = el('div', { className: 'messages-scroll', tabindex: 0, 'aria-label': '聊天记录' }, list);
    const errors = el('div', { className: 'composer-error' });
    const textarea = el('textarea', { rows: 2, maxlength: 12000, placeholder: '说说你正在推进的事…', 'aria-label': '消息内容', enterKeyHint: 'enter' });
    const send = button('', () => activeRun ? onStop(activeRun) : submit(), { className: 'button primary send-button', name: '发送消息', glyph: 'arrow' });
    const compose = el('form', { className: 'composer' }, textarea, el('div', { className: 'composer-bottom' },
        el('div', { className: 'composer-identity' }, icon('spark'), el('span', { text: 'AI七嫂·员工专属版' })),
        send));
    const readonly = el('div', { className: 'composer-read-only', hidden: true }, icon('lock'), el('span'));
    const meta = el('div', { className: 'composer-meta', text: '内部工作空间 · 回答请结合实际情况判断' });
    const region = el('div', { className: 'composer-region' }, el('div', { className: 'composer-wrap' }, errors, compose, readonly, meta));
    const views = new Map();
    let conversation = null;
    let activeRun = null;
    let busy = false;
    let lastKey;
    let renderFrame;

    function resize() {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, matchMedia('(max-width:720px)').matches ? 130 : 170) + 'px';
    }
    function storeDraft() {
        if (!lastKey) return;
        try { textarea.value ? sessionStorage.setItem(lastKey, textarea.value) : sessionStorage.removeItem(lastKey); } catch {}
    }
    textarea.addEventListener('input', () => { storeDraft(); resize(); updateControls(); });
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(max-width:720px)').matches) {
            event.preventDefault();
            if (!activeRun) submit();
        }
    });
    compose.addEventListener('submit', event => { event.preventDefault(); if (!activeRun) submit(); });
    async function submit() {
        const content = textarea.value.trim();
        if (!content || busy || activeRun || conversation?.readOnly || project?.archived) return;
        busy = true; updateControls(); errors.replaceChildren();
        try {
            if (conversation?.memoryEnabled === false && onMemoryChange) conversation = await onMemoryChange(conversation, true);
            await onSend(content, true);
        }
        catch (error) { if (error.code !== 'STALE_RESPONSE') showError(error.message); }
        finally { busy = false; updateControls(); }
    }
    function updateControls() {
        const locked = Boolean(conversation?.readOnly || project?.archived);
        compose.hidden = locked;
        readonly.hidden = !locked;
        readonly.lastElementChild.textContent = project?.archived ? '项目已归档，此对话为只读。' : '同事的原始聊天仅供项目管理员查看。';
        textarea.disabled = busy;
        send.disabled = busy || (!activeRun && !textarea.value.trim());
        send.replaceChildren(icon(activeRun ? 'stop' : 'arrow'));
        send.setAttribute('aria-label', activeRun ? '停止生成' : '发送消息');
        send.title = activeRun ? '停止生成' : '发送消息';
        meta.textContent = '内部工作空间 · 回答请结合实际情况判断';
    }
    function showError(message) { errors.replaceChildren(notice(message || '操作未完成，请重试。', 'error')); }
    function welcome() {
        const suggestions = project ? ['梳理一下项目的下一步', '帮我整理这次讨论的重点', '一起推敲一个执行方案'] : ['帮我理清一个工作问题', '把想法整理成行动计划', '帮我打磨一段表达'];
        return el('section', { className: 'welcome' }, el('div', { className: 'welcome-avatar' }, el('img', { className: 'brand-avatar', src: '/static/img/avatar-192.png', alt: 'AI七嫂·员工专属版' })),
            el('div', { className: 'welcome-label', text: project ? 'PROJECT WORKSPACE' : 'YOUR WORKING PARTNER' }),
            el('h1', { text: project ? '让想法，在这里往前走。' : '每一步，都有思路。' }),
            el('p', { text: project ? '围绕「' + project.name + '」展开讨论。项目背景与经审核的共享记忆，会帮助回答更贴近你的工作。' : '从一个问题、一段想法开始。把重要的背景留在记忆里，让下一次讨论接得上。' }),
            !project?.archived && el('div', { className: 'suggestions' }, ...suggestions.map(text => button(text, () => { textarea.value = text; storeDraft(); resize(); updateControls(); textarea.focus(); }, { className: 'chip' }))),
            el('div', { className: 'welcome-footnote' }, icon('shield'), el('span', { text: project ? '项目管理员可查看本项目聊天，系统管理员可全局审计。' : '个人聊天仅本人及系统管理员审计可见。' })));
    }
    function setConversation(value, messages = [], run = null) {
        storeDraft();
        conversation = value;
        activeRun = run && !terminal.has(run.state) ? run : null;
        lastKey = draftKey(user.id, value?.id, project?.id);
        try { textarea.value = sessionStorage.getItem(lastKey) || ''; } catch { textarea.value = ''; }
        views.clear(); list.replaceChildren();
        if (!messages.length) list.append(welcome());
        for (const message of messages) upsert(message, false);
        updateControls(); resize();
        requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    }
    function upsert(message, scroll = true) {
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
        let view = views.get(message.id);
        if (!view) {
            list.querySelector('.welcome')?.remove();
            view = messageView(message, { onMemory });
            views.set(message.id, view); list.append(view.element);
        } else view.update(message);
        if (scroll && atBottom) {
            cancelAnimationFrame(renderFrame);
            renderFrame = requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
        }
    }
    return { scroller, region, setConversation, upsert, showError,
        setRun(run) { activeRun = run && !terminal.has(run.state) ? run : null; updateControls(); },
        clearDraft() { textarea.value = ''; storeDraft(); resize(); updateControls(); },
        setUser(value) { user = value; updateControls(); },
        focus() { textarea.focus(); },
        dispose() { storeDraft(); cancelAnimationFrame(renderFrame); },
    };
}

export function followRun(runId, { onUpdate, onState, onConnection, onFinished, onDenied }) {
    let stopped = false;
    let controller;
    let retryTimer;
    let message = null;
    let run = null;
    let connecting = false;
    let frame;
    let finishCalled = false;
    function publish() {
        if (stopped) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { if (!stopped && message) onUpdate(message); });
        if (run) onState(run);
        if (run && terminal.has(run.state) && !finishCalled) {
            finishCalled = true;
            cancelAnimationFrame(frame);
            if (message) onUpdate(message);
            onFinished(run, message);
        }
    }
    function snapshot(data) {
        if (data.message) message = data.message;
        if (data.run) run = data.run;
        publish();
    }
    function event(type, data) {
        if (stopped) return;
        if (type === 'snapshot' || type === 'done' || type === 'error') snapshot(data);
        if (type === 'delta') {
            if (!message || typeof data.delta !== 'string' || !Number.isInteger(data.offset) || data.offset < 0) throw new Error('实时内容需要重新同步。');
            const current = message.content || '';
            if (data.offset > current.length) throw new Error('实时内容需要重新同步。');
            const overlap = current.length - data.offset;
            if (overlap < data.delta.length) message = { ...message, content: current + data.delta.slice(overlap), status: 'generating' };
            publish();
        }
    }
    async function connect() {
        if (stopped || connecting || finishCalled || document.hidden) return;
        connecting = true;
        controller = new AbortController();
        onConnection('');
        try {
            snapshot(await api('/api/chat/runs/' + encodeURIComponent(runId), { signal: controller.signal }));
            if (finishCalled || stopped) return;
            await subscribeRun(runId, event, { signal: controller.signal });
            if (!stopped && !finishCalled) onConnection('连接已中断，正在同步保存的回答…');
        } catch (error) {
            if (error.code === 'STALE_RESPONSE' || error.status === 401 || error.status === 403 || error.status === 404) { stopped = true; if (error.code !== 'STALE_RESPONSE') { onConnection(error.message); onDenied?.(error); } return; }
            if (error.name !== 'AbortError' && !stopped) onConnection('连接暂时中断，返回前台后会继续同步。');
        } finally {
            connecting = false;
            if (!stopped && !finishCalled && !document.hidden) retryTimer = setTimeout(connect, 1800);
        }
    }
    function wake() {
        if (document.hidden) { controller?.abort(); return; }
        clearTimeout(retryTimer);
        if (!connecting) connect();
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    connect();
    return { dispose() { stopped = true; controller?.abort(); clearTimeout(retryTimer); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake); }, sync: wake };
}
