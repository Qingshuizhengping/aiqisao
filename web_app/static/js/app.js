/**
 * AI七嫂 - 薇之雨品牌智能问答系统
 * 前端JavaScript
 */

const chatContainer = document.getElementById('chatContainer');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const mainPanel = document.getElementById('mainPanel');
const welcomeTemplate = document.getElementById('welcomeTemplate');
const sidebarList = document.getElementById('sidebarList');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const menuBtn = document.getElementById('menuBtn');
const mobileSidebarQuery = window.matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1000px)');

let isProcessing = false;
let conversations = [];
let currentConvId = null;

const STORAGE_KEY = 'qisao_conversations';

// 加载对话历史
function loadConversations() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) conversations = JSON.parse(raw);
    } catch(e) {
        conversations = [];
    }
}

// 保存对话历史
function saveConversations() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch(e) {}
}

// 生成ID
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// 格式化日期
function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff/60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff/3600000) + '小时前';
    if (diff < 172800000) return '昨天';
    return (d.getMonth()+1) + '/' + d.getDate();
}

// 获取对话标题
function getConvTitle(conv) {
    if (conv.title) return conv.title;
    const first = conv.messages.find(m => m.role === 'user');
    if (first) {
        const t = first.text;
        return t.length > 16 ? t.substring(0, 16) + '…' : t;
    }
    return '新对话';
}

// 渲染侧边栏
function renderSidebar() {
    sidebarList.innerHTML = '';
    const sorted = [...conversations].sort((a,b) => b.updatedAt - a.updatedAt);
    if (!sorted.length) {
        const empty = document.createElement('div');
        empty.className = 'sidebar-empty';
        empty.innerHTML = '<span>还没有对话记录</span><span>每一次交流，都从这里开始</span>';
        sidebarList.appendChild(empty);
        return;
    }
    sorted.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (conv.id === currentConvId ? ' active' : '');
        const title = getConvTitle(conv);
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'chat-item-select';
        selectButton.disabled = isProcessing;
        selectButton.setAttribute('aria-pressed', String(conv.id === currentConvId));
        selectButton.innerHTML = `
            <span class="ui-icon icon-message" aria-hidden="true"></span>
            <span class="chat-item-info">
                <span class="chat-item-title">${escapeHtml(title)}</span>
                <span class="chat-item-date">${formatDate(conv.updatedAt)}</span>
            </span>
        `;
        selectButton.addEventListener('click', () => switchChat(conv.id));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'chat-item-delete';
        deleteButton.disabled = isProcessing;
        deleteButton.setAttribute('aria-label', '删除对话：' + title);
        deleteButton.innerHTML = '<span class="ui-icon icon-trash" aria-hidden="true"></span>';
        deleteButton.addEventListener('click', () => deleteChat(conv.id));
        item.append(selectButton, deleteButton);
        sidebarList.appendChild(item);
    });
}

// 新建对话
function newChat() {
    if (isProcessing) return;
    currentConvId = null;
    chatContainer.replaceChildren(welcomeTemplate.content.cloneNode(true));
    mainPanel.classList.add('is-welcome');
    renderSidebar();
    closeSidebar();
}

// 切换对话
function switchChat(convId) {
    if (isProcessing) return;
    const conv = conversations.find(c => c.id === convId);
    if (!conv) return;
    currentConvId = convId;
    mainPanel.classList.remove('is-welcome');
    chatContainer.innerHTML = '';
    conv.messages.forEach(msg => {
        if (msg.role === 'user') {
            const div = document.createElement('div');
            div.className = 'message message-user';
            div.innerHTML = '<div class="bubble">' + escapeHtml(msg.text) + '</div>';
            chatContainer.appendChild(div);
        } else if (msg.role === 'qisao') {
            const div = document.createElement('div');
            div.className = 'message message-qisao';
            div.innerHTML = `<div class="qisao-avatar"><img src="/avatar.png" class="avatar-img"></div><div class="qisao-bubble">${msg.html}</div>`;
            chatContainer.appendChild(div);
        }
    });
    scrollToBottom();
    renderSidebar();
    closeSidebar();
}

// 删除对话
function deleteChat(convId) {
    if (isProcessing) return;
    conversations = conversations.filter(c => c.id !== convId);
    saveConversations();
    if (currentConvId === convId) {
        newChat();
    }
    renderSidebar();
}

// 获取当前对话
function getCurrentConv() {
    if (!currentConvId) return null;
    return conversations.find(c => c.id === currentConvId);
}

// 确保对话存在
function ensureConv() {
    if (!currentConvId) {
        const conv = {
            id: genId(),
            title: '',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        conversations.push(conv);
        currentConvId = conv.id;
        saveConversations();
        renderSidebar();
    }
    return getCurrentConv();
}

// 切换侧边栏
function toggleSidebar() {
    if (!mobileSidebarQuery.matches) return;
    sidebar.classList.toggle('open');
    updateSidebarState();
    if (sidebar.classList.contains('open')) {
        sidebar.querySelector('button, a[href], input, [tabindex="0"]')?.focus();
    } else {
        menuBtn.focus();
    }
}

// 关闭侧边栏
function closeSidebar(restoreFocus = true) {
    const wasOpen = sidebar.classList.contains('open');
    const hadFocus = sidebar.contains(document.activeElement);
    sidebar.classList.remove('open');
    updateSidebarState();
    if (restoreFocus && mobileSidebarQuery.matches && (wasOpen || hadFocus)) {
        menuBtn.focus();
    }
}

function updateSidebarState() {
    const isOpen = sidebar.classList.contains('open');
    const isMobile = mobileSidebarQuery.matches;
    sidebar.inert = isMobile && !isOpen;
    mainPanel.inert = isMobile && isOpen;
    sidebarOverlay.classList.toggle('show', isMobile && isOpen);
    menuBtn.setAttribute('aria-expanded', String(!isMobile || isOpen));
}

mobileSidebarQuery.addEventListener('change', () => closeSidebar());

document.addEventListener('keydown', event => {
    if (!mobileSidebarQuery.matches || !sidebar.classList.contains('open')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...sidebar.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !sidebar.contains(activeElement))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (activeElement === last || !sidebar.contains(activeElement))) {
        event.preventDefault();
        first.focus();
    }
});

// 自动调整文本框高度
function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

userInput.addEventListener('input', function() { autoResize(this); });

// 处理键盘事件
function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendMessage();
    }
}

// 快速提问
function quickAsk(question) {
    if (isProcessing) return;
    userInput.value = question;
    sendMessage();
}

// 隐藏欢迎界面
function hideWelcome() {
    const ws = document.getElementById('welcomeSection');
    if (ws) ws.style.display = 'none';
    mainPanel.classList.remove('is-welcome');
}

// 添加用户消息
function addUserMessage(text) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message message-user';
    div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
    chatContainer.appendChild(div);
    scrollToBottom();
}

// 添加七嫂消息
function addQisaoMessage(html) {
    const div = document.createElement('div');
    div.className = 'message message-qisao';
    div.innerHTML = `
        <div class="qisao-avatar"><img src="/avatar.png" class="avatar-img"></div>
        <div class="qisao-bubble">${html}</div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
}

// 创建流式消息容器（带加载动画）
function createStreamingQisaoMessage() {
    const div = document.createElement('div');
    div.className = 'message message-qisao';
    div.innerHTML = `
        <div class="qisao-avatar"><img src="/avatar.png" class="avatar-img"></div>
        <div class="qisao-bubble">
            <div class="stream-loading" id="streamLoading">
                <span class="loading-dot"></span>
                <span class="loading-dot"></span>
                <span class="loading-dot"></span>
            </div>
        </div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
    return div.querySelector('.qisao-bubble');
}

// 移除流式加载动画
function removeStreamLoading() {
    const loading = document.getElementById('streamLoading');
    if (loading) loading.remove();
}

// 渲染流式文本
function renderStreamingText(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// 添加系统消息
function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message message-system';
    div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
    chatContainer.appendChild(div);
    scrollToBottom();
}

// 显示输入指示器
function showTyping() {
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typingIndicator';
    div.innerHTML = `
        <div class="qisao-avatar" style="width:32px;height:32px;flex-shrink:0;"><img src="/avatar.png" class="avatar-img"></div>
        <div class="typing-bubble"><span class="typing-label">Thinking</span><div class="typing-dots"><span></span><span></span><span></span></div></div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
}

// 隐藏输入指示器
function hideTyping() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
}

// 滚动到底部
function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// HTML转纯文本
function htmlToPlainText(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return div.textContent || div.innerText || '';
}

// 构建对话上下文
function buildConversationContext(conv) {
    if (!conv || !Array.isArray(conv.messages)) return [];
    return conv.messages.slice(-8).map(msg => {
        if (msg.role === 'user') {
            return { role: 'user', content: msg.text || '' };
        }
        return { role: 'assistant', content: htmlToPlainText(msg.html || msg.text || '') };
    }).filter(msg => msg.content && msg.content.trim());
}

// 带超时的 fetch
function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// 获取普通回答
async function fetchNormalAnswer(text, conv, history) {
    const resp = await fetchWithTimeout('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, history: history || [] })
    }, 30000);
    const data = await resp.json();
    hideTyping();

    if (data.status === 'ok') {
        addQisaoMessage(data.html);
        conv.messages.push({ role: 'qisao', html: data.html });
        conv.updatedAt = Date.now();
        saveConversations();
        return true;
    }

    addSystemMessage('查询出错: ' + (data.error || '未知错误'));
    return false;
}

// 发送消息
async function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    sendBtn.disabled = true;
    document.querySelectorAll('.quick-btn, .new-chat-btn').forEach(button => {
        button.disabled = true;
    });
    mainPanel.setAttribute('aria-busy', 'true');
    userInput.value = '';
    userInput.style.height = 'auto';

    const conv = ensureConv();
    addUserMessage(text);
    conv.messages.push({ role: 'user', text: text });
    if (!conv.title) conv.title = text.length > 16 ? text.substring(0, 16) + '…' : text;
    conv.updatedAt = Date.now();
    saveConversations();
    renderSidebar();

    const history = buildConversationContext(conv);

    showTyping();

    try {
        const resp = await fetchWithTimeout('/api/query_stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text, history: history })
        }, 30000);

        if (!resp.ok || !resp.body || !window.ReadableStream) {
            await fetchNormalAnswer(text, conv, history);
        } else {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let markdownText = '';
            let finalHtml = '';
            let bubble = null;
            let hasStarted = false;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (!payload) continue;

                let data;
                try {
                    data = JSON.parse(payload);
                } catch (e) {
                    continue;
                }

                if (data.type === 'start') {
                    hasStarted = true;
                    hideTyping();
                    if (!bubble) bubble = createStreamingQisaoMessage();
                } else if (data.type === 'token') {
                    hasStarted = true;
                    if (!bubble) {
                        hideTyping();
                        bubble = createStreamingQisaoMessage();
                    }
                    // 移除加载动画（首次收到token时）
                    removeStreamLoading();
                    markdownText += data.content || '';
                    bubble.innerHTML = renderStreamingText(markdownText);
                    scrollToBottom();
                } else if (data.type === 'done') {
                    hasStarted = true;
                    // 移除加载动画
                    removeStreamLoading();
                    finalHtml = data.html || renderStreamingText(markdownText);
                    if (!bubble) {
                        hideTyping();
                        bubble = createStreamingQisaoMessage();
                    }
                    bubble.innerHTML = finalHtml;
                    conv.messages.push({ role: 'qisao', html: finalHtml });
                    conv.updatedAt = Date.now();
                    saveConversations();
                    scrollToBottom();
                } else if (data.type === 'error') {
                    hideTyping();
                    removeStreamLoading();
                    addSystemMessage('查询出错: ' + (data.error || '未知错误'));
                }
            }
        }

            if (!hasStarted) {
                await fetchNormalAnswer(text, conv, history);
            }
        }
    } catch (err) {
        hideTyping();
        if (err.name === 'AbortError') {
            addSystemMessage('请求超时，服务器响应过慢，请稍后重试');
        } else {
            try {
                await fetchNormalAnswer(text, conv, history);
            } catch (fallbackErr) {
                hideTyping();
                addSystemMessage('网络错误，请检查网络连接后重试');
            }
        }
    }

    isProcessing = false;
    sendBtn.disabled = false;
    document.querySelectorAll('.quick-btn, .new-chat-btn').forEach(button => {
        button.disabled = false;
    });
    mainPanel.setAttribute('aria-busy', 'false');
    renderSidebar();
    if (!window.matchMedia('(pointer: coarse)').matches && !mobileSidebarQuery.matches) {
        userInput.focus({ preventScroll: true });
    }
}

// 初始化应用
function initApp() {
    updateSidebarState();
    loadConversations();
    renderSidebar();
    
    if (conversations.length > 0) {
        const sorted = [...conversations].sort((a,b) => b.updatedAt - a.updatedAt);
        switchChat(sorted[0].id);
    } else {
        newChat();
    }
}

// 启动应用
initApp();
