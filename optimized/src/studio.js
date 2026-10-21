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
    var sizeNote = document.getElementById('sizeNote');
    var refInput = document.getElementById('refInput');
    var refLabel = document.getElementById('refLabel');
    var refClear = document.getElementById('refClear');
    var refPreview = document.getElementById('refPreview');
    var refCount = document.getElementById('refCount');
    var refPick = document.querySelector('.ref-pick[for="refInput"]');
    var generateBtn = document.getElementById('generateBtn');
    var generateLabel = document.getElementById('generateLabel');
    var serviceStatus = document.getElementById('serviceStatus');

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
    var REQUEST_TIMEOUT = 240000;
    var MAX_REFERENCES = 20;
    var MAX_REFERENCE_FILE_BYTES = 20 * 1024 * 1024;
    var MAX_REFERENCE_CHARS = 14000000;

    var DEFAULT_SIZE = '1:1';
    var currentSize = DEFAULT_SIZE;
    var references = [];
    var isReadingReferences = false;
    var history = [];
    var isBusy = false;
    var timerId = 0;
    var startedAt = 0;
    var lastPrompt = '';
    var serviceReady = true;

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
        var label = generationLabel();
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
        syncControls();
    }

    function generationLabel() {
        return currentSize === 'auto' ? '正在按描述自动确定尺寸…' : '正在生成 ' + currentSize + ' · 2K 图…';
    }

    function syncControls() {
        var locked = isBusy || isReadingReferences;
        generateBtn.disabled = locked || !serviceReady;
        generateLabel.textContent = isBusy ? '生成中…' : isReadingReferences ? '正在读取图片…' : '生成图片';
        refInput.disabled = locked || references.length >= MAX_REFERENCES;
        if (refPick) refPick.setAttribute('aria-disabled', String(refInput.disabled));
        refClear.disabled = locked;
        asRefBtn.disabled = locked || references.length >= MAX_REFERENCES;
        againBtn.disabled = locked;
        errorRetry.disabled = locked;
        promptEl.disabled = isReadingReferences;
        refPreview.setAttribute('aria-busy', String(isReadingReferences));
        document.querySelectorAll('#refPreview .ref-remove, #sizeChips .size-chip, #presets .chip').forEach(function (button) { button.disabled = locked; });
        if (refCount) refCount.textContent = references.length + ' / ' + MAX_REFERENCES + ' 张' + (isReadingReferences ? ' · 正在读取…' : '');
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
        if (!chip || isBusy || isReadingReferences) return;
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
        if (!chip || isBusy || isReadingReferences) return;
        var chips = sizeChips.querySelectorAll('.size-chip');
        for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', String(chips[i] === chip));
        currentSize = chip.dataset.size || DEFAULT_SIZE;
        if (sizeNote) sizeNote.textContent = currentSize === 'auto' ? '自动 · 模型自适应' : currentSize + ' · 2K';
        if (stageLoading.hidden === false) return;
        loadingText.textContent = generationLabel();
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
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () {
                var w = img.naturalWidth || 0;
                var h = img.naturalHeight || 0;
                if (!w || !h) return reject(new Error('参考图尺寸无效，请换一张图片'));
                var scale = Math.min(1, 1600 / Math.max(w, h));
                if (scale >= 1 && dataUrl.length < 1200000 && /^data:image\/(?:png|jpe?g);base64,/i.test(dataUrl)) return resolve(dataUrl);
                try {
                    var cw = Math.round(w * scale);
                    var chh = Math.round(h * scale);
                    var canvas = document.createElement('canvas');
                    canvas.width = cw;
                    canvas.height = chh;
                    var ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error('无法处理参考图');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, cw, chh);
                    ctx.drawImage(img, 0, 0, cw, chh);
                    var resized = canvas.toDataURL('image/jpeg', 0.86);
                    if (!/^data:image\/jpeg;base64,/.test(resized)) throw new Error('参考图压缩失败');
                    resolve(resized);
                } catch (e) {
                    reject(new Error('参考图处理失败，请换一张 PNG / JPG / WebP 图片'));
                }
            };
            img.onerror = function () { reject(new Error('参考图无法读取，请使用有效的 PNG / JPG / WebP 图片')); };
            img.src = dataUrl;
        });
    }

    function renderReferences() {
        var has = references.length > 0;
        var fragment = document.createDocumentFragment();
        references.forEach(function (reference, index) {
            var figure = document.createElement('figure');
            figure.className = 'ref-preview-item';
            figure.setAttribute('role', 'listitem');
            var image = document.createElement('img');
            image.src = reference.dataUrl;
            image.alt = '参考图 ' + (index + 1);
            image.title = reference.name || image.alt;
            image.loading = 'lazy';
            image.decoding = 'async';
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ref-remove';
            remove.dataset.referenceIndex = String(index);
            remove.setAttribute('aria-label', '移除参考图 ' + (index + 1));
            remove.textContent = '×';
            var caption = document.createElement('figcaption');
            caption.textContent = '参考图 ' + (index + 1);
            figure.append(image, remove, caption);
            fragment.appendChild(figure);
        });
        refPreview.replaceChildren(fragment);
        refPreview.hidden = !has;
        refClear.hidden = !has;
        refLabel.textContent = has ? '继续添加参考图' : '上传参考图';
        syncControls();
    }

    async function appendReferences(items, prepare) {
        if (isBusy || isReadingReferences || !items.length) return false;
        if (references.length + items.length > MAX_REFERENCES) {
            showError('最多添加 ' + MAX_REFERENCES + ' 张参考图，请先移除一些图片');
            return false;
        }
        isReadingReferences = true;
        syncControls();
        var additions = [];
        var totalChars = references.reduce(function (total, reference) { return total + reference.dataUrl.length; }, 0);
        try {
            for (var index = 0; index < items.length; index++) {
                var reference = await prepare(items[index]);
                if (!reference || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(reference.dataUrl)) throw new Error('参考图格式不支持');
                totalChars += reference.dataUrl.length;
                if (totalChars > MAX_REFERENCE_CHARS) throw new Error('参考图总大小过大，请减少图片或换成更小的图片');
                additions.push(reference);
            }
            references = references.concat(additions);
            return true;
        } catch (error) {
            showError(error.message || '参考图读取失败，换一张试试');
            return false;
        } finally {
            isReadingReferences = false;
            renderReferences();
        }
    }

    refInput.addEventListener('change', async function () {
        var files = Array.from(refInput.files || []);
        if (isBusy || isReadingReferences || !files.length) { refInput.value = ''; return; }
        try {
            files.forEach(function (file) {
                if (!/^image\/(?:png|jpe?g|webp)$/i.test(file.type)) throw new Error('参考图仅支持 PNG / JPG / WebP 图片');
                if (!file.size || file.size > MAX_REFERENCE_FILE_BYTES) throw new Error('单张参考图不能超过 20MB，请换成更小的图片');
            });
            await appendReferences(files, async function (file) {
                return { dataUrl: await shrinkImage(await readFileAsDataUrl(file)), name: file.name };
            });
        } catch (error) {
            showError(error.message || '参考图读取失败，换一张试试');
        } finally {
            refInput.value = '';
        }
    });

    refClear.addEventListener('click', function () {
        if (isBusy || isReadingReferences) return;
        references = [];
        renderReferences();
    });

    refPreview.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-reference-index]');
        if (!button || !refPreview.contains(button) || isBusy || isReadingReferences) return;
        var index = Number(button.dataset.referenceIndex);
        if (!Number.isInteger(index) || index < 0 || index >= references.length) return;
        references.splice(index, 1);
        renderReferences();
    });

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
        if (isBusy || isReadingReferences) return;
        if (!serviceReady) {
            showError('生图服务尚未启用，请联系管理员配置。');
            return;
        }
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
                referenceImages: references.length ? references.map(function (reference) { return reference.dataUrl; }) : undefined
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
        if (!url || isBusy || isReadingReferences) return;
        var added = await appendReferences([url], async function (source) {
            var resp = await fetch(source);
            if (!resp.ok) throw new Error('这张图读取失败，可先下载再手动上传');
            var blob = await resp.blob();
            if (!blob.size || blob.size > MAX_REFERENCE_FILE_BYTES) throw new Error('这张图片超过 20MB，请下载并缩小后再上传');
            var dataUrl = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result || '')); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            return { dataUrl: await shrinkImage(dataUrl), name: '生成结果' };
        });
        if (added) promptEl.focus();
    });

    /* ------------------------------ 启动 ------------------------------ */
    function init() {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
        syncCharCount();
        loadHistory();
        renderHistory();
        setStage('empty');
        if (sizeNote) sizeNote.textContent = '默认 1:1 · 2K';
        renderReferences();

        fetch('/api/health', { signal: AbortSignal.timeout(8000) }).then(function (response) {
            if (!response.ok) throw new Error('Service unavailable');
            return response.json();
        }).then(function (data) {
            if (typeof data.imageReady !== 'boolean') return;
            serviceReady = data.imageReady;
            setBusy(isBusy);
            if (serviceStatus && !serviceReady) {
                serviceStatus.hidden = false;
                serviceStatus.textContent = '生图服务尚未启用，请联系管理员配置。';
            }
        }).catch(function () {});

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
