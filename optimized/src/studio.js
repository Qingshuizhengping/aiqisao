/**
 * 薇之雨 · 素材生成（独立入口 /image）
 * 只依赖主站的 CSS 令牌，不碰对话页的任何逻辑。
 */
(function () {
    'use strict';

    var promptEl = document.getElementById('prompt');
    var charCount = document.getElementById('charCount');
    var presetsEl = document.getElementById('presets');
    var sizeChips = document.getElementById('sizeChips');
    var refInput = document.getElementById('refInput');
    var refLabel = document.getElementById('refLabel');
    var refClear = document.getElementById('refClear');
    var refPreview = document.getElementById('refPreview');
    var refThumb = document.getElementById('refThumb');
    var generateBtn = document.getElementById('generateBtn');
    var generateLabel = document.getElementById('generateLabel');

    var stageEmpty = document.getElementById('stageEmpty');
    var stageLoading = document.getElementById('stageLoading');
    var stageResult = document.getElementById('stageResult');
    var stageError = document.getElementById('stageError');
    var loadingText = document.getElementById('loadingText');
    var resultImg = document.getElementById('resultImg');
    var downloadBtn = document.getElementById('downloadBtn');
    var asRefBtn = document.getElementById('asRefBtn');
    var againBtn = document.getElementById('againBtn');
    var resultPrompt = document.getElementById('resultPrompt');
    var errorText = document.getElementById('errorText');
    var errorRetry = document.getElementById('errorRetry');

    var historyGrid = document.getElementById('historyGrid');
    var historyClear = document.getElementById('historyClear');
    var lightbox = document.getElementById('lightbox');
    var lightboxImg = document.getElementById('lightboxImg');
    var lightboxClose = document.getElementById('lightboxClose');
    var themeToggle = document.getElementById('themeToggle');

    var HISTORY_KEY = 'qisao_studio_history';
    var MAX_HISTORY = 36;
    var MAX_PROMPT = 4000;
    var REQUEST_TIMEOUT = 180000;

    var DEFAULT_SIZE = '1:1';
    var currentSize = DEFAULT_SIZE;
    var referenceDataUrl = '';
    var history = [];
    var isBusy = false;
    var timerId = 0;
    var startedAt = 0;
    var lastPrompt = '';

    /* ------------------------------ 主题 ------------------------------ */
    function applyTheme(theme, persist) {
        document.documentElement.dataset.theme = theme;
        var metas = document.querySelectorAll('meta[name="theme-color"]');
        for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', theme === 'dark' ? '#08090b' : '#ffffff');
        if (themeToggle) {
            themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
            themeToggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
        }
        if (persist) { try { localStorage.setItem('qisao_theme', theme); } catch (e) {} }
    }

    function toggleTheme() {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
    }

    /* ------------------------------ 状态 ------------------------------ */
    function setStage(name) {
        stageEmpty.hidden = name !== 'empty';
        stageLoading.hidden = name !== 'loading';
        stageResult.hidden = name !== 'result';
        stageError.hidden = name !== 'error';
    }

    function startTimer() {
        startedAt = Date.now();
        var label = '正在生成 ' + currentSize + ' · 2K 图…';
        loadingText.textContent = label;
        stopTimer();
        timerId = setInterval(function () {
            var sec = Math.round((Date.now() - startedAt) / 1000);
            loadingText.textContent = sec < 6 ? label : label.replace('…', '… 已用 ' + sec + ' 秒');
        }, 1000);
    }

    function stopTimer() {
        if (timerId) { clearInterval(timerId); timerId = 0; }
    }

    function setBusy(busy) {
        isBusy = busy;
        generateBtn.disabled = busy;
        generateLabel.textContent = busy ? '生成中…' : '生成图片';
    }

    function showError(message) {
        setStage('error');
        errorText.textContent = message || '生成失败，请稍后重试';
    }

    /* ------------------------------ 提示词 ------------------------------ */
    function syncCharCount() {
        charCount.textContent = promptEl.value.length + ' / ' + MAX_PROMPT;
    }

    promptEl.addEventListener('input', syncCharCount);

    presetsEl.addEventListener('click', function (event) {
        var chip = event.target.closest('.chip');
        if (!chip || isBusy) return;
        promptEl.value = chip.dataset.prompt || '';
        syncCharCount();
        promptEl.focus();
    });

    promptEl.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            generate();
        }
    });

    /* ------------------------------ 尺寸 ------------------------------ */
    sizeChips.addEventListener('click', function (event) {
        var chip = event.target.closest('.size-chip');
        if (!chip || isBusy) return;
        var chips = sizeChips.querySelectorAll('.size-chip');
        for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', String(chips[i] === chip));
        currentSize = chip.dataset.size || DEFAULT_SIZE;
        if (stageLoading.hidden === false) return;
        loadingText.textContent = '正在生成 ' + currentSize + ' · 2K 图…';
    });

    /* ------------------------------ 参考图 ------------------------------ */
    function readFileAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('读取图片失败')); };
            reader.readAsDataURL(file);
        });
    }

    // 长边压到 1600、转 JPEG，控制上行体积（上游单图上限 20MB）
    function shrinkImage(dataUrl) {
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                var w = img.naturalWidth || 0;
                var h = img.naturalHeight || 0;
                if (!w || !h) return resolve(dataUrl);
                var scale = Math.min(1, 1600 / Math.max(w, h));
                if (scale >= 1 && dataUrl.length < 1200000) return resolve(dataUrl);
                try {
                    var cw = Math.round(w * scale);
                    var chh = Math.round(h * scale);
                    var canvas = document.createElement('canvas');
                    canvas.width = cw;
                    canvas.height = chh;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, cw, chh);
                    ctx.drawImage(img, 0, 0, cw, chh);
                    resolve(canvas.toDataURL('image/jpeg', 0.86));
                } catch (e) {
                    resolve(dataUrl);
                }
            };
            img.onerror = function () { resolve(dataUrl); };
            img.src = dataUrl;
        });
    }

    function setReference(dataUrl) {
        referenceDataUrl = dataUrl || '';
        var has = Boolean(referenceDataUrl);
        refPreview.hidden = !has;
        refClear.hidden = !has;
        refLabel.textContent = has ? '已选参考图' : '上传参考图';
        if (has) refThumb.src = referenceDataUrl;
        else refThumb.removeAttribute('src');
    }

    refInput.addEventListener('change', async function () {
        var file = refInput.files && refInput.files[0];
        if (!file) return;
        try {
            var raw = await readFileAsDataUrl(file);
            setReference(await shrinkImage(raw));
        } catch (e) {
            showError('参考图读取失败，换一张试试');
        }
        refInput.value = '';
    });

    refClear.addEventListener('click', function () { setReference(''); });

    /* ------------------------------ 历史 ------------------------------ */
    function loadHistory() {
        try {
            var raw = localStorage.getItem(HISTORY_KEY);
            var parsed = raw ? JSON.parse(raw) : [];
            history = Array.isArray(parsed) ? parsed.filter(function (item) { return item && item.url; }) : [];
        } catch (e) {
            history = [];
        }
    }

    function saveHistory() {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY))); } catch (e) {}
    }

    function renderHistory() {
        historyClear.hidden = history.length === 0;
        var fragment = document.createDocumentFragment();
        history.forEach(function (item) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'history-item';
            button.title = item.prompt || '生成结果';
            var img = document.createElement('img');
            img.src = item.url;
            img.alt = item.prompt ? item.prompt.slice(0, 30) : '生成结果';
            img.loading = 'lazy';
            img.decoding = 'async';
            button.appendChild(img);
            button.addEventListener('click', function () { openLightbox(item.url); });
            fragment.appendChild(button);
        });
        historyGrid.replaceChildren(fragment);
    }

    function pushHistory(entry) {
        history = [entry].concat(history.filter(function (item) { return item.url !== entry.url; })).slice(0, MAX_HISTORY);
        saveHistory();
        renderHistory();
    }

    historyClear.addEventListener('click', function () {
        if (!history.length) return;
        history = [];
        saveHistory();
        renderHistory();
    });

    /* ------------------------------ 大图 ------------------------------ */
    function openLightbox(url) {
        if (!url) return;
        lightboxImg.src = url;
        lightbox.hidden = false;
    }

    function closeLightbox() {
        lightbox.hidden = true;
        lightboxImg.removeAttribute('src');
    }

    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function (event) {
        if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !lightbox.hidden) closeLightbox();
    });

    /* ------------------------------ 生成 ------------------------------ */
    async function callApi(payload) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT);
        try {
            var resp = await fetch('/api/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            var data = null;
            try { data = await resp.json(); } catch (e) { /* 非 JSON 走下面的兜底 */ }
            if (!resp.ok || !data || data.status !== 'ok') {
                throw new Error((data && data.error) || ('生成失败 HTTP ' + resp.status));
            }
            return data;
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('生成超时了，稍后重试或把描述写简单一点');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    function showResult(data, prompt) {
        setStage('result');
        resultImg.src = data.url;
        downloadBtn.href = data.url;
        downloadBtn.setAttribute('download', 'qisao-' + Date.now() + '.png');
        resultPrompt.textContent = data.revisedPrompt ? '模型改写：' + data.revisedPrompt : prompt;
        pushHistory({ url: data.url, prompt: prompt, ts: Date.now() });
    }

    async function generate() {
        if (isBusy) return;
        var prompt = promptEl.value.trim();
        if (!prompt) {
            promptEl.focus();
            showError('先写一句想生成什么，比如「哑银外盒产品平铺图，柔光」');
            return;
        }
        if (prompt.length > MAX_PROMPT) {
            showError('提示词超过 ' + MAX_PROMPT + ' 字了，精简一下');
            return;
        }

        lastPrompt = prompt;
        setBusy(true);
        setStage('loading');
        startTimer();

        try {
            var data = await callApi({
                prompt: prompt,
                size: currentSize,
                referenceImage: referenceDataUrl || undefined
            });
            showResult(data, prompt);
        } catch (e) {
            showError(e && e.message ? e.message : '生成失败，请稍后重试');
        } finally {
            stopTimer();
            setBusy(false);
        }
    }

    generateBtn.addEventListener('click', generate);
    againBtn.addEventListener('click', function () {
        if (lastPrompt && !promptEl.value.trim()) {
            promptEl.value = lastPrompt;
            syncCharCount();
        }
        generate();
    });
    errorRetry.addEventListener('click', function () {
        setStage(stageResult.hidden ? 'empty' : 'result');
        generate();
    });

    resultImg.addEventListener('click', function () { openLightbox(resultImg.src); });

    // 把结果当参考图，走图生图继续改
    asRefBtn.addEventListener('click', async function () {
        var url = resultImg.getAttribute('src');
        if (!url) return;
        asRefBtn.disabled = true;
        try {
            var resp = await fetch(url);
            var blob = await resp.blob();
            var dataUrl = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result || '')); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            setReference(await shrinkImage(dataUrl));
            promptEl.focus();
        } catch (e) {
            showError('这张图读取失败，可先下载再手动上传');
        } finally {
            asRefBtn.disabled = false;
        }
    });

    /* ------------------------------ 启动 ------------------------------ */
    function init() {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
        syncCharCount();
        loadHistory();
        renderHistory();
        setStage('empty');

        var params = new URLSearchParams(location.search);
        var seeded = params.get('prompt');
        if (seeded) {
            promptEl.value = seeded.slice(0, MAX_PROMPT);
            syncCharCount();
        }

        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    }

    init();
})();
