/**
 * 薇之雨 · AI 七嫂 —— 前端逻辑
 * 相比原版的改动（均为内部实现，不改交互）：
 *  1. 流式输出按帧合并渲染（原来每个 token 重写一次 innerHTML）
 *  2. 历史对话用 DocumentFragment 一次性插入
 *  3. 侧边栏列表按签名比对，内容没变就不重建 DOM
 *  4. 滚动只在"贴底"时才跟随，用户上滑阅读不会被打断
 *  5. 玻璃光泽跟随指针（rAF 节流），不再用 canvas 逐像素算折射图
 *  6. 主题切换 + 离线提示 + 光场按需加载
 */
import { renderMarkdown } from './markdown.js';

(function () {
    'use strict';

    var chatContainer = document.getElementById('chatContainer');
    var userInput = document.getElementById('userInput');
    var sendBtn = document.getElementById('sendBtn');
    var mainPanel = document.getElementById('mainPanel');
    var welcomeTemplate = document.getElementById('welcomeTemplate');
    var sidebarList = document.getElementById('sidebarList');
    var sidebar = document.getElementById('sidebar');
    var sidebarOverlay = document.getElementById('sidebarOverlay');
    var menuBtn = document.getElementById('menuBtn');
    var themeToggle = document.getElementById('themeToggle');
    var offlineBanner = document.getElementById('offlineBanner');
    var mobileSidebarQuery = window.matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1000px)');
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    var AVATAR = '/static/img/avatar-96.webp';

    var isProcessing = false;
    var conversations = [];
    var currentConvId = null;
    var STORAGE_KEY = 'qisao_conversations';
    var CLIENT_VERSION = 'qisao-v20261023-1';
    var DRAFT_KEY = 'qisao_update_draft';
    var updateBanner = document.getElementById('updateBanner');
    var updateAppBtn = document.getElementById('updateAppBtn');

    /* ------------------------------ 主题 ------------------------------ */
    function updateMetaTheme(theme) {
        var metas = document.querySelectorAll('meta[name="theme-color"]');
        for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', theme === 'dark' ? '#08090b' : '#ffffff');
    }

    function applyTheme(theme, persist) {
        document.documentElement.dataset.theme = theme;
        if (themeToggle) {
            themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
            themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
        }
        updateMetaTheme(theme);
        if (persist) { try { localStorage.setItem('qisao_theme', theme); } catch (e) {} }
        window.dispatchEvent(new CustomEvent('qisao:theme', { detail: theme }));
    }

    function toggleTheme() {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
    }

    /* ------------------------------ 存储 ------------------------------ */
    function loadConversations() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) conversations = JSON.parse(raw) || [];
        } catch (e) {
            conversations = [];
        }
    }

    function saveConversations() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch (e) {}
    }

    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function formatDate(ts) {
        var d = new Date(ts);
        var diff = Date.now() - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
        if (diff < 172800000) return '昨天';
        return (d.getMonth() + 1) + '/' + d.getDate();
    }

    function getConvTitle(conv) {
        if (conv.title) return conv.title;
        var first = (conv.messages || []).filter(function (m) { return m.role === 'user'; })[0];
        if (first) {
            var t = first.text || '';
            return t.length > 16 ? t.slice(0, 16) + '…' : t;
        }
        return '新对话';
    }

    /* ------------------------------ 侧边栏 ------------------------------ */
    var sidebarSignature = '';

    function renderSidebar(force) {
        var sorted = conversations.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        var signature = currentConvId + '|' + sorted.map(function (c) { return c.id + c.updatedAt + (c.title || ''); }).join(',');
        if (!force && signature === sidebarSignature) return;
        sidebarSignature = signature;

        var fragment = document.createDocumentFragment();

        if (!sorted.length) {
            var empty = document.createElement('div');
            empty.className = 'sidebar-empty';
            empty.innerHTML = '<span>还没有对话记录</span><span>每一次交流，都从这里开始</span>';
            fragment.appendChild(empty);
            sidebarList.replaceChildren(fragment);
            return;
        }

        sorted.forEach(function (conv) {
            var item = document.createElement('div');
            item.className = 'chat-item' + (conv.id === currentConvId ? ' active' : '');

            var selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.className = 'chat-item-select';
            selectButton.disabled = isProcessing;
            selectButton.setAttribute('aria-pressed', String(conv.id === currentConvId));
            selectButton.innerHTML =
                '<span class="ui-icon icon-message" aria-hidden="true"></span>' +
                '<span class="chat-item-info">' +
                '<span class="chat-item-title">' + escapeHtml(getConvTitle(conv)) + '</span>' +
                '<span class="chat-item-date">' + formatDate(conv.updatedAt) + '</span>' +
                '</span>';
            selectButton.addEventListener('click', function () { switchChat(conv.id); });

            var deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'chat-item-delete';
            deleteButton.disabled = isProcessing;
            deleteButton.setAttribute('aria-label', '删除对话：' + getConvTitle(conv));
            deleteButton.innerHTML = '<span class="ui-icon icon-trash" aria-hidden="true"></span>';
            deleteButton.addEventListener('click', function () { deleteChat(conv.id); });

            item.append(selectButton, deleteButton);
            fragment.appendChild(item);
        });

        sidebarList.replaceChildren(fragment);
    }

    function newChat() {
        if (isProcessing) return;
        currentConvId = null;
        chatContainer.classList.remove('is-long');
        chatContainer.replaceChildren(welcomeTemplate.content.cloneNode(true));
        mainPanel.classList.add('is-welcome');
        renderSidebar(true);
        closeSidebar();
    }

    function switchChat(convId) {
        if (isProcessing) return;
        var conv = conversations.find(function (c) { return c.id === convId; });
        if (!conv) return;
        currentConvId = convId;
        mainPanel.classList.remove('is-welcome');

        var messages = conv.messages || [];
        var fragment = document.createDocumentFragment();

        for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            var div = document.createElement('div');
            if (msg.role === 'user') {
                div.className = 'message message-user';
                div.innerHTML = '<div class="bubble">' + escapeHtml(msg.text || '') + '</div>';
            } else if (msg.role === 'qisao') {
                div.className = 'message message-qisao';
                div.innerHTML = qisaoMessageMarkup('');
                var savedBubble = div.querySelector('.qisao-bubble');
                savedBubble.appendChild(renderAnswerText(msg.text || htmlToMarkdown(msg.html || '')));
                if (msg.incomplete) {
                    var savedNotice = document.createElement('p');
                    savedNotice.className = 'stream-notice';
                    savedNotice.textContent = msg.notice || '回答未完成，请重试。';
                    savedBubble.appendChild(savedNotice);
                }
            } else {
                continue;
            }
            fragment.appendChild(div);
        }

        chatContainer.replaceChildren(fragment);
        // 长对话才启用 content-visibility，短对话保持精确布局
        chatContainer.classList.toggle('is-long', messages.length > 24);
        scrollToBottom();
        renderSidebar(true);
        closeSidebar();
    }

    function deleteChat(convId) {
        if (isProcessing) return;
        conversations = conversations.filter(function (c) { return c.id !== convId; });
        saveConversations();
        if (currentConvId === convId) newChat();
        renderSidebar(true);
    }

    function ensureConv() {
        if (!currentConvId) {
            var conv = { id: genId(), title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
            conversations.push(conv);
            currentConvId = conv.id;
            saveConversations();
            renderSidebar(true);
        }
        return conversations.find(function (c) { return c.id === currentConvId; });
    }

    /* ------------------------------ 侧边栏开合 ------------------------------ */
    function toggleSidebar() {
        if (!mobileSidebarQuery.matches) return;
        sidebar.classList.toggle('open');
        updateSidebarState();
        if (sidebar.classList.contains('open')) {
            var first = sidebar.querySelector('button, a[href], input, [tabindex="0"]');
            if (first) first.focus();
        } else if (menuBtn) {
            menuBtn.focus();
        }
    }

    function closeSidebar(restoreFocus) {
        var wasOpen = sidebar.classList.contains('open');
        var hadFocus = sidebar.contains(document.activeElement);
        sidebar.classList.remove('open');
        updateSidebarState();
        if (restoreFocus !== false && mobileSidebarQuery.matches && (wasOpen || hadFocus) && menuBtn) menuBtn.focus();
    }

    function updateSidebarState() {
        var isOpen = sidebar.classList.contains('open');
        var isMobile = mobileSidebarQuery.matches;
        sidebar.inert = isMobile && !isOpen;
        mainPanel.inert = isMobile && isOpen;
        if (sidebarOverlay) sidebarOverlay.classList.toggle('show', isMobile && isOpen);
        if (menuBtn) menuBtn.setAttribute('aria-expanded', String(!isMobile || isOpen));
    }

    mobileSidebarQuery.addEventListener('change', function () { closeSidebar(false); });

    document.addEventListener('keydown', function (event) {
        if (!mobileSidebarQuery.matches || !sidebar.classList.contains('open')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSidebar();
            return;
        }
        if (event.key !== 'Tab') return;
        var focusable = Array.prototype.filter.call(
            sidebar.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]'),
            function (element) { return element.getClientRects().length > 0; }
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        var active = document.activeElement;
        if (event.shiftKey && (active === first || !sidebar.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !sidebar.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    });

    /* ------------------------------ 输入 ------------------------------ */
    var resizeFrame = 0;

    function autoResize(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 108) + 'px';
    }

    userInput.addEventListener('input', function () {
        var el = this;
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(function () {
            resizeFrame = 0;
            autoResize(el);
        });
    });

    function handleKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            sendMessage();
        }
    }

    function quickAsk(question) {
        if (isProcessing) return;
        userInput.value = question;
        sendMessage();
    }

    /* ------------------------------ 消息渲染 ------------------------------ */
    function avatarMarkup() {
        return '<div class="qisao-avatar"><img src="' + AVATAR + '" class="avatar-img" width="96" height="96" alt="" loading="lazy" decoding="async"></div>';
    }

    function qisaoMessageMarkup(html) {
        return avatarMarkup() + '<div class="qisao-bubble">' + html + '</div>';
    }

    function hideWelcome() {
        var ws = document.getElementById('welcomeSection');
        if (ws) ws.style.display = 'none';
        mainPanel.classList.remove('is-welcome');
    }

    function addUserMessage(text) {
        hideWelcome();
        var div = document.createElement('div');
        div.className = 'message message-user';
        div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
        chatContainer.appendChild(div);
        scrollToBottom(true);
    }

    function addQisaoMessage(html) {
        var div = document.createElement('div');
        div.className = 'message message-qisao';
        div.innerHTML = qisaoMessageMarkup(html);
        chatContainer.appendChild(div);
        scrollToBottom();
    }

    function createStreamingQisaoMessage() {
        var div = document.createElement('div');
        div.className = 'message message-qisao';
        div.innerHTML =
            avatarMarkup() +
            '<div class="qisao-bubble is-streaming">' +
            '<div class="stream-loading" id="streamLoading"><span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span><span class="stream-status" role="status">正在连接模型…</span></div>' +
            '</div>';
        chatContainer.appendChild(div);
        scrollToBottom();
        return div.querySelector('.qisao-bubble');
    }

    function removeStreamLoading() {
        var loading = document.getElementById('streamLoading');
        if (loading) loading.remove();
    }

    function renderStreamingText(text) {
        var container = document.createElement('div');
        container.appendChild(renderAnswerText(text));
        return container.innerHTML;
    }

    function renderAnswerText(text) {
        var template = document.createElement('template');
        template.innerHTML = renderMarkdown(text);
        return template.content;
    }

    function addSystemMessage(text) {
        var div = document.createElement('div');
        div.className = 'message message-system';
        div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
        chatContainer.appendChild(div);
        scrollToBottom();
    }

    function showTyping() {
        var div = document.createElement('div');
        div.className = 'typing-indicator';
        div.id = 'typingIndicator';
        div.innerHTML = avatarMarkup() +
            '<div class="typing-bubble"><span class="typing-label">正在连接模型…</span><div class="typing-dots"><span></span><span></span><span></span></div></div>';
        chatContainer.appendChild(div);
        scrollToBottom();
    }

    function hideTyping() {
        var el = document.getElementById('typingIndicator');
        if (el) el.remove();
    }

    /* 只在用户本来就贴着底部时才自动滚动，避免读历史被打断 */
    function isNearBottom() {
        return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 140;
    }

    function scrollToBottom(force) {
        if (!force && !isNearBottom()) return;
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'instant' });
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text == null ? '' : text;
        return div.innerHTML;
    }

    function htmlToPlainText(html) {
        var documentBody = new DOMParser().parseFromString(html || '', 'text/html').body;
        documentBody.querySelectorAll('script, style, iframe, object, embed, .client-update').forEach(function (element) { element.remove(); });
        documentBody.querySelectorAll('br').forEach(function (element) { element.replaceWith('\n'); });
        documentBody.querySelectorAll('p, div, li, h1, h2, h3, h4, blockquote, pre, tr').forEach(function (element) { element.appendChild(document.createTextNode('\n')); });
        return documentBody.textContent.trim();
    }

    function htmlToMarkdown(html) {
        var body = new DOMParser().parseFromString(html || '', 'text/html').body;
        body.querySelectorAll('script, style, iframe, object, embed, .client-update').forEach(function (element) { element.remove(); });
        function convert(node) {
            if (node.nodeType === 3) return node.textContent;
            if (node.nodeType !== 1) return '';
            var tag = node.tagName.toLowerCase();
            var content = Array.from(node.childNodes).map(convert).join('');
            if (tag === 'br') return '\n';
            if (tag === 'pre' || tag === 'code') {
                var text = node.textContent;
                var runs = text.match(/`+/g) || [];
                var marker = '`'.repeat(Math.max(tag === 'pre' ? 3 : 1, ...runs.map(function (run) { return run.length + 1; })));
                return tag === 'pre' ? '\n\n' + marker + '\n' + text + '\n' + marker + '\n\n' : marker + ' ' + text + ' ' + marker;
            }
            if (tag === 'strong' || tag === 'b') return '**' + content + '**';
            if (tag === 'em' || tag === 'i') return '*' + content + '*';
            if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content + '\n\n';
            if (tag === 'li') return '\n' + (node.parentElement.tagName === 'OL' ? (Array.from(node.parentElement.children).indexOf(node) + 1) + '. ' : '- ') + content.trim();
            if (tag === 'blockquote') return '\n\n' + content.trim().split('\n').map(function (line) { return '> ' + line; }).join('\n') + '\n\n';
            if (/^(p|div|ul|ol|table|tr)$/.test(tag)) return '\n\n' + content.trim() + '\n\n';
            return content;
        }
        return Array.from(body.childNodes).map(convert).join('').trim();
    }

    function buildConversationContext(conv) {
        if (!conv || !Array.isArray(conv.messages)) return [];
        return conv.messages.filter(function (msg) { return !msg.incomplete; }).slice(-8).map(function (msg) {
            if (msg.role === 'user') return { role: 'user', content: msg.text || '' };
            return { role: 'assistant', content: msg.text || htmlToPlainText(msg.html || '') };
        }).filter(function (msg) { return msg.content && msg.content.trim(); });
    }

    /* ------------------------------ 网络 ------------------------------ */
    function syncOnline() {
        if (!offlineBanner) return;
        offlineBanner.classList.toggle('show', !navigator.onLine);
    }

    async function fetchNormalAnswer(text, conv, history) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 30000);
        var data;
        try {
            var resp = await fetch('/api/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: text, history: history || [], clientVersion: CLIENT_VERSION }),
                signal: controller.signal
            });
            data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '服务暂时不可用');
        } finally {
            clearTimeout(timer);
        }
        hideTyping();

        if (data.status === 'ok') {
            var answer = typeof data.text === 'string' ? data.text : htmlToPlainText(data.html || '');
            var html = renderStreamingText(answer);
            addQisaoMessage(html);
            conv.messages.push({ role: 'qisao', text: answer, html: html });
            conv.updatedAt = Date.now();
            saveConversations();
            return true;
        }

        addSystemMessage('查询出错: ' + (data.error || '未知错误'));
        return false;
    }

    /* ------------------------------ 发送 ------------------------------ */
    async function sendMessage() {
        var text = userInput.value.trim();
        if (!text || isProcessing) return;

        isProcessing = true;
        sendBtn.disabled = true;
        if (updateAppBtn) updateAppBtn.disabled = true;
        document.querySelectorAll('.quick-btn, .new-chat-btn').forEach(function (button) { button.disabled = true; });
        mainPanel.setAttribute('aria-busy', 'true');
        userInput.value = '';
        userInput.style.height = 'auto';

        var conv = ensureConv();
        var history = buildConversationContext(conv);
        addUserMessage(text);
        conv.messages.push({ role: 'user', text: text });
        if (!conv.title) conv.title = text.length > 16 ? text.slice(0, 16) + '…' : text;
        conv.updatedAt = Date.now();
        saveConversations();
        renderSidebar(true);

        showTyping();

        var controller = new AbortController();
        var idleTimer = 0;
        var totalTimer = setTimeout(function () { controller.abort(); }, 180000);
        var pendingRender = 0;
        var finished = false;
        var markdownText = '';
        var bubble = null;
        var renderedPrefix = 0;
        var tail = null;
        var tailText = '';
        var previewTimer = 0;
        var previewAt = 0;

        function resetIdleTimer() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(function () { controller.abort(); }, 30000);
        }

        function ensureBubble() {
            if (!bubble) { hideTyping(); bubble = createStreamingQisaoMessage(); }
            return bubble;
        }

        function previewTail() {
            previewTimer = 0;
            if (finished || !tail) return;
            var follow = isNearBottom();
            tail.classList.add('is-formatted');
            tail.replaceChildren(renderAnswerText(markdownText.slice(renderedPrefix)));
            previewAt = performance.now();
            if (follow) scrollToBottom(true);
        }

        function paint() {
            pendingRender = 0;
            if (finished || !markdownText) return;
            var follow = isNearBottom();
            ensureBubble();
            if (!tail) {
                tail = document.createElement('div');
                tail.className = 'stream-tail';
                tail.appendChild(document.createTextNode(''));
                bubble.replaceChildren(tail);
            }
            var boundary = markdownText.lastIndexOf('\n\n');
            while (boundary >= renderedPrefix && (markdownText.slice(0, boundary).match(/^\s*(?:`{3,}|~{3,})/gm) || []).length % 2) boundary = markdownText.lastIndexOf('\n\n', boundary - 1);
            if (boundary >= renderedPrefix) {
                bubble.insertBefore(renderAnswerText(markdownText.slice(renderedPrefix, boundary + 2)), tail);
                renderedPrefix = boundary + 2;
                clearTimeout(previewTimer);
                previewTimer = 0;
                previewAt = 0;
                tail.classList.remove('is-formatted');
                tail.replaceChildren(document.createTextNode(''));
                tailText = '';
            }
            var nextTail = markdownText.slice(renderedPrefix);
            if (tail.classList.contains('is-formatted') || /[*_`[\]|]|^\s*(?:#{1,6}\s|>\s|[-+]\s|\d+[.)]\s)/m.test(nextTail)) {
                if (performance.now() - previewAt >= 80) previewTail();
                else if (!previewTimer) previewTimer = setTimeout(previewTail, 80 - (performance.now() - previewAt));
            } else {
                tail.firstChild.appendData(nextTail.slice(tailText.length));
            }
            tailText = nextTail;
            if (follow) scrollToBottom(true);
        }

        function saveAnswer(answer, notice) {
            conv.messages.push({ role: 'qisao', text: answer, html: renderStreamingText(answer), incomplete: !!notice, notice: notice || '' });
            conv.updatedAt = Date.now();
            saveConversations();
        }

        function interrupt(message) {
            if (finished) return;
            finished = true;
            if (pendingRender) cancelAnimationFrame(pendingRender);
            clearTimeout(previewTimer);
            hideTyping();
            if (markdownText.trim()) {
                var follow = isNearBottom();
                ensureBubble().classList.remove('is-streaming');
                bubble.replaceChildren(renderAnswerText(markdownText));
                saveAnswer(markdownText, message);
                var notice = document.createElement('p');
                notice.className = 'stream-notice';
                notice.setAttribute('role', 'status');
                notice.textContent = message;
                bubble.appendChild(notice);
                if (follow) scrollToBottom(true);
            } else {
                if (bubble) bubble.parentElement.remove();
                addSystemMessage(message);
            }
        }

        function receive(data) {
            if (finished) return;
            if (data.type === 'start' || data.type === 'status') {
                ensureBubble();
                var status = bubble.querySelector('.stream-status');
                if (status && data.stage === 'thinking') status.textContent = '正在整理思路…';
            } else if (data.type === 'token') {
                markdownText += data.content || '';
                if (!pendingRender) pendingRender = requestAnimationFrame(paint);
            } else if (data.type === 'done') {
                var answer = typeof data.text === 'string' ? data.text : markdownText || htmlToPlainText(data.html || '');
                if (!answer.trim()) { interrupt('未收到回答正文，请重试。'); return; }
                var follow = isNearBottom();
                finished = true;
                if (pendingRender) cancelAnimationFrame(pendingRender);
                clearTimeout(previewTimer);
                ensureBubble().classList.remove('is-streaming');
                bubble.replaceChildren(renderAnswerText(answer));
                saveAnswer(answer);
                if (follow) scrollToBottom(true);
            } else if (data.type === 'error') {
                interrupt('查询出错：' + (data.error || '连接中断，请重试。'));
            }
        }

        try {
            resetIdleTimer();
            var resp = await fetch('/api/query_stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: text, history: history, clientVersion: CLIENT_VERSION }),
                signal: controller.signal
            });

            if (!resp.ok || !resp.body || !window.ReadableStream) {
                await resp.body?.cancel();
                clearTimeout(idleTimer);
                clearTimeout(totalTimer);
                await fetchNormalAnswer(text, conv, history);
            } else {
                var reader = resp.body.getReader();
                var decoder = new TextDecoder('utf-8');
                var buffer = '';
                var dataLines = [];

                function dispatch() {
                    if (!dataLines.length) return;
                    var payload = dataLines.join('\n');
                    dataLines = [];
                    receive(JSON.parse(payload));
                }

                function readLine(line) {
                    if (!line) dispatch();
                    else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
                }

                function consume(value, atEnd) {
                    buffer += value;
                    var ending;
                    while ((ending = /\r\n|\r|\n/.exec(buffer))) {
                        if (!atEnd && ending[0] === '\r' && ending.index === buffer.length - 1) break;
                        readLine(buffer.slice(0, ending.index));
                        buffer = buffer.slice(ending.index + ending[0].length);
                        if (finished) return;
                    }
                    if (atEnd && !finished) { if (buffer) readLine(buffer); dispatch(); buffer = ''; }
                }

                while (!finished) {
                    var chunk = await reader.read();
                    resetIdleTimer();
                    if (chunk.done) { consume(decoder.decode(), true); break; }
                    consume(decoder.decode(chunk.value, { stream: true }), false);
                }
                if (!finished) interrupt('连接中断，已保留收到的内容，请重试。');
                await reader.cancel().catch(function () {});
            }
        } catch (err) {
            interrupt(err.name === 'AbortError' ? '响应超时，已保留收到的内容，请重试。' : '连接中断，已保留收到的内容，请检查网络后重试。');
        } finally {
            clearTimeout(idleTimer);
            clearTimeout(totalTimer);
            clearTimeout(previewTimer);
            if (pendingRender) cancelAnimationFrame(pendingRender);
            controller.abort();
        }

        isProcessing = false;
        sendBtn.disabled = false;
        if (updateAppBtn) updateAppBtn.disabled = false;
        document.querySelectorAll('.quick-btn, .new-chat-btn').forEach(function (button) { button.disabled = false; });
        mainPanel.setAttribute('aria-busy', 'false');
        renderSidebar(true);
        if (!window.matchMedia('(pointer: coarse)').matches && !mobileSidebarQuery.matches) {
            userInput.focus({ preventScroll: true });
        }
    }

    /* ------------------------------ 玻璃光泽 ------------------------------ */
    var sheenFrame = 0;
    var sheenEvent = null;

    function paintSheen() {
        sheenFrame = 0;
        var event = sheenEvent;
        if (!event) return;
        var el = event.target.closest && event.target.closest('.glass, .sidebar');
        if (!el) return;
        var rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        el.style.setProperty('--mx', ((event.clientX - rect.left) / rect.width * 100) + '%');
        el.style.setProperty('--my', ((event.clientY - rect.top) / rect.height * 100) + '%');
    }

    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        document.addEventListener('pointermove', function (event) {
            sheenEvent = event;
            if (!sheenFrame) sheenFrame = requestAnimationFrame(paintSheen);
        }, { passive: true });
    }

    /* ------------------------------ 背景光场 ------------------------------ */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (!secure) return;
        function checkVersion() {
            var worker = navigator.serviceWorker.controller;
            if (!worker || !window.MessageChannel) return;
            var channel = new MessageChannel();
            var timer = setTimeout(function () { channel.port1.close(); }, 2000);
            channel.port1.onmessage = function (event) {
                clearTimeout(timer);
                channel.port1.close();
                if (event.data && event.data.type === 'QISAO_VERSION' && event.data.version !== CLIENT_VERSION && updateBanner) updateBanner.hidden = false;
            };
            worker.postMessage({ type: 'QISAO_VERSION' }, [channel.port2]);
        }
        navigator.serviceWorker.addEventListener('controllerchange', checkVersion);
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(function (registration) {
            checkVersion();
            window.addEventListener('online', function () { registration.update().catch(function () {}); });
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) registration.update().catch(function () {});
            });
        }).catch(function () {});
    }

    function updateApp() {
        if (isProcessing) return;
        try {
            sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text: userInput.value, conversationId: currentConvId }));
        } catch (error) {
            if (updateBanner) updateBanner.querySelector('span').textContent = '无法保存草稿，请先复制草稿再重新打开应用。';
            return;
        }
        var url = new URL(location.href);
        url.searchParams.set('v', Date.now().toString(36));
        location.replace(url.href);
    }

    function restoreUpdateDraft() {
        try {
            var saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
            if (!saved) return;
            if (saved.conversationId) switchChat(saved.conversationId);
            else newChat();
            userInput.value = typeof saved.text === 'string' ? saved.text : '';
            userInput.dispatchEvent(new Event('input'));
            sessionStorage.removeItem(DRAFT_KEY);
        } catch (error) {}
    }

    function loadLightField() {
        if (reduceMotion.matches) return;
        if (!window.WebGLRenderingContext) return;
        var canvas = document.getElementById('lightField');
        if (!canvas) return;
        var script = document.createElement('script');
        script.src = '/static/js/lightfield.js';
        script.async = true;
        document.head.appendChild(script);
    }

    /* ------------------------------ 视口 / 软键盘 ------------------------------ */
    /* 合并自原 viewport.js，逻辑一致，只是并进主文件少一个请求 */
    function setupViewport() {
        var root = document.documentElement;
        var mobileQuery = window.matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1000px), (pointer: coarse)');
        var pending = 0;
        var pointerActive = false;

        function sync() {
            if (pending) cancelAnimationFrame(pending);
            pending = 0;
            var viewport = window.visualViewport;
            var isMobile = mobileQuery.matches;
            var keyboardVisible = viewport && Math.abs(viewport.scale - 1) < 0.05 &&
                Math.max(root.clientHeight, window.innerHeight) - viewport.height > 120;
            var keepEditing = root.classList.contains('is-input-focused') && (pointerActive || keyboardVisible);
            root.classList.toggle('is-input-focused', isMobile && (document.activeElement === userInput || keepEditing));

            if (!isMobile) {
                root.style.removeProperty('--app-height');
                root.style.removeProperty('--app-offset-top');
                root.classList.remove('is-viewport-short');
                return;
            }

            if (viewport && Math.abs(viewport.scale - 1) >= 0.05) return;

            var height = viewport ? viewport.height : window.innerHeight;
            var offsetTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
            if (height > 0) root.style.setProperty('--app-height', height + 'px');
            root.style.setProperty('--app-offset-top', offsetTop + 'px');
            root.classList.toggle('is-viewport-short', height < 360);
        }

        function schedule() {
            if (!pending) pending = requestAnimationFrame(sync);
        }

        document.addEventListener('focusin', sync);
        document.addEventListener('focusout', schedule);
        document.addEventListener('pointerdown', function () { pointerActive = true; }, { passive: true });
        document.addEventListener('pointerup', function () { pointerActive = false; schedule(); }, { passive: true });
        document.addEventListener('pointercancel', function () { pointerActive = false; schedule(); }, { passive: true });
        mobileQuery.addEventListener('change', schedule);
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('pageshow', schedule);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', schedule);
            window.visualViewport.addEventListener('scroll', schedule, { passive: true });
        }
        sync();
    }

    /* ------------------------------ 启动 ------------------------------ */
    function initApp() {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
        setupViewport();
        updateSidebarState();
        syncOnline();
        loadConversations();
        renderSidebar(true);

        if (conversations.length > 0) {
            var sorted = conversations.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
            switchChat(sorted[0].id);
            // 恢复历史后把视口拉回底部，历史渲染完成再定位更稳
            requestAnimationFrame(function () { scrollToBottom(true); });
        } else {
            newChat();
        }

        restoreUpdateDraft();
        if (updateAppBtn) updateAppBtn.addEventListener('click', updateApp);

        if (document.readyState === 'complete') {
            setTimeout(loadLightField, 300);
            setTimeout(registerServiceWorker, 2000);
        } else {
            window.addEventListener('load', function () {
                if (window.requestIdleCallback) requestIdleCallback(loadLightField, { timeout: 1500 });
                else setTimeout(loadLightField, 300);
                setTimeout(registerServiceWorker, 2000);
            });
        }
    }

    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);

    // 暴露给 HTML 内联事件
    window.toggleTheme = toggleTheme;
    window.newChat = newChat;
    window.switchChat = switchChat;
    window.deleteChat = deleteChat;
    window.toggleSidebar = toggleSidebar;
    window.closeSidebar = closeSidebar;
    window.handleKeyDown = handleKeyDown;
    window.quickAsk = quickAsk;
    window.sendMessage = sendMessage;

    initApp();
})();
