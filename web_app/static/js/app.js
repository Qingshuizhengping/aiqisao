/**
 * AI七嫂 - 薇之雨品牌智能问答系统
 * 前端JavaScript
 */

const chatContainer = document.getElementById('chatContainer');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const welcomeSection = document.getElementById('welcomeSection');
const sidebarList = document.getElementById('sidebarList');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

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
    sorted.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (conv.id === currentConvId ? ' active' : '');
        item.onclick = (e) => {
            if (e.target.closest('.chat-item-delete')) return;
            switchChat(conv.id);
        };
        item.innerHTML = `
            <div class="chat-item-icon">💬</div>
            <div class="chat-item-info">
                <div class="chat-item-title">${escapeHtml(getConvTitle(conv))}</div>
                <div class="chat-item-date">${formatDate(conv.updatedAt)}</div>
            </div>
            <button class="chat-item-delete" onclick="deleteChat('${conv.id}')">✕</button>
        `;
        sidebarList.appendChild(item);
    });
}

// 新建对话
function newChat() {
    currentConvId = null;
    chatContainer.innerHTML = '';
    const ws = document.createElement('div');
    ws.className = 'welcome-section';
    ws.id = 'welcomeSection';
    ws.innerHTML = `
        <div class="welcome-icon"><img src="/avatar.png" class="welcome-avatar-img"></div>
        <h2>你好，我是AI七嫂</h2>
        <p>有什么问题直接问，我知无不言，言无不尽！</p>
        <div class="welcome-quote">
            <blockquote>记住啊，美业就是修心，修好了自己的心，客户自然就来了。</blockquote>
        </div>
    `;
    chatContainer.appendChild(ws);
    renderSidebar();
    closeSidebar();
}

// 切换对话
function switchChat(convId) {
    const conv = conversations.find(c => c.id === convId);
    if (!conv) return;
    currentConvId = convId;
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
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('show');
}

// 关闭侧边栏
function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('show');
}

// 自动调整文本框高度
function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

userInput.addEventListener('input', function() { autoResize(this); });

// 处理键盘事件
function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// 快速提问
function quickAsk(question) {
    userInput.value = question;
    sendMessage();
}

// 隐藏欢迎界面
function hideWelcome() {
    const ws = document.getElementById('welcomeSection');
    if (ws) ws.style.display = 'none';
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

// 获取普通回答
async function fetchNormalAnswer(text, conv, history) {
    const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, history: history || [] })
    });
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
        const resp = await fetch('/api/query_stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text, history: history })
        });

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
        try {
            await fetchNormalAnswer(text, conv, history);
        } catch (fallbackErr) {
            hideTyping();
            addSystemMessage('网络错误，请重试');
        }
    }

    isProcessing = false;
    sendBtn.disabled = false;
    userInput.focus();
}

// 初始化应用
function initApp() {
    loadConversations();
    renderSidebar();
    
    // 如果有保存的对话，显示最后一个对话；否则显示欢迎界面
    if (conversations.length > 0) {
        const sorted = [...conversations].sort((a,b) => b.updatedAt - a.updatedAt);
        switchChat(sorted[0].id);
    }
    // 如果没有对话，HTML中已包含欢迎界面，无需额外处理
}

// 启动应用
initApp();
