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
                div.innerHTML = qisaoMessageMarkup(msg.html || '');
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
        scrollToBottom();
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
            '<div class="stream-loading" id="streamLoading"><span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span></div>' +
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
        return escapeHtml(text).replace(/\n/g, '<br>');
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
            '<div class="typing-bubble"><span class="typing-label">Thinking</span><div class="typing-dots"><span></span><span></span><span></span></div></div>';
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
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text == null ? '' : text;
        return div.innerHTML;
    }

    function htmlToPlainText(html) {
        var div = document.createElement('div');
        div.innerHTML = html || '';
        return div.textContent || div.innerText || '';
    }

    function buildConversationContext(conv) {
        if (!conv || !Array.isArray(conv.messages)) return [];
        return conv.messages.slice(-8).map(function (msg) {
            if (msg.role === 'user') return { role: 'user', content: msg.text || '' };
            return { role: 'assistant', content: htmlToPlainText(msg.html || msg.text || '') };
        }).filter(function (msg) { return msg.content && msg.content.trim(); });
    }

    /* ------------------------------ 网络 ------------------------------ */
    function fetchWithTimeout(url, options, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        return fetch(url, Object.assign({}, options, { signal: controller.signal }))
            .finally(function () { clearTimeout(timer); });
    }

    function syncOnline() {
        if (!offlineBanner) return;
        offlineBanner.classList.toggle('show', !navigator.onLine);
    }

    async function fetchNormalAnswer(text, conv, history) {
        var resp = await fetchWithTimeout('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text, history: history || [] })
        }, 30000);
        var data = await resp.json();
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

    /* ------------------------------ 发送 ------------------------------ */
    async function sendMessage() {
        var text = userInput.value.trim();
        if (!text || isProcessing) return;

        isProcessing = true;
        sendBtn.disabled = true;
        document.querySelectorAll('.quick-btn, .new-chat-btn').forEach(function (button) { button.disabled = true; });
        mainPanel.setAttribute('aria-busy', 'true');
        userInput.value = '';
        userInput.style.height = 'auto';

        var conv = ensureConv();
        addUserMessage(text);
        conv.messages.push({ role: 'user', text: text });
        if (!conv.title) conv.title = text.length > 16 ? text.slice(0, 16) + '…' : text;
        conv.updatedAt = Date.now();
        saveConversations();
        renderSidebar(true);

        var history = buildConversationContext(conv);
        showTyping();

        try {
            var resp = await fetchWithTimeout('/api/query_stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: text, history: history })
            }, 30000);

            if (!resp.ok || !resp.body || !window.ReadableStream) {
                await fetchNormalAnswer(text, conv, history);
            } else {
                var reader = resp.body.getReader();
                var decoder = new TextDecoder('utf-8');
                var buffer = '';
                var markdownText = '';
                var bubble = null;
                var hasStarted = false;

                // 按帧合并：无论一帧内来多少 token，只写一次 DOM
                var pendingRender = false;
                var renderedLength = 0;
                var finished = false;

                function flush() {
                    pendingRender = false;
                    // finished 之后不能再写，否则会覆盖 done 阶段渲染好的 HTML
                    if (finished || !bubble || markdownText.length === renderedLength) return;
                    renderedLength = markdownText.length;
                    bubble.textContent = markdownText; // 流式阶段用纯文本，避免反复解析 HTML
                    scrollToBottom();
                }

                function schedule() {
                    if (pendingRender) return;
                    pendingRender = true;
                    requestAnimationFrame(flush);
                }

                while (true) {
                    var chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });
                    var lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';

                    for (var li = 0; li < lines.length; li++) {
                        var line = lines[li];
                        if (line.indexOf('data: ') !== 0) continue;
                        var payload = line.slice(6).trim();
                        if (!payload) continue;

                        var data;
                        try { data = JSON.parse(payload); } catch (e) { continue; }

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
                            if (renderedLength === 0) removeStreamLoading();
                            markdownText += data.content || '';
                            schedule();
                        } else if (data.type === 'done') {
                            hasStarted = true;
                            finished = true;
                            removeStreamLoading();
                            var finalHtml = data.html || renderStreamingText(markdownText);
                            if (!bubble) {
                                hideTyping();
                                bubble = createStreamingQisaoMessage();
                            }
                            bubble.classList.remove('is-streaming');
                            bubble.innerHTML = finalHtml;
                            conv.messages.push({ role: 'qisao', html: finalHtml });
                            conv.updatedAt = Date.now();
                            saveConversations();
                            scrollToBottom(true);
                        } else if (data.type === 'error') {
                            finished = true;
                            hideTyping();
                            removeStreamLoading();
                            addSystemMessage('查询出错: ' + (data.error || '未知错误'));
                        }
                    }
                }

                if (!hasStarted) await fetchNormalAnswer(text, conv, history);
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
        navigator.serviceWorker.register('/sw.js').catch(function () {});
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
