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
    var optimizeToggle = document.getElementById('optimizeToggle');
    var optimizeStatus = document.getElementById('optimizeStatus');

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
    var useOriginalBtn = document.getElementById('useOriginalBtn');
    var stageClarification = document.getElementById('stageClarification');
    var clarificationQuestion = document.getElementById('clarificationQuestion');
    var clarificationEdit = document.getElementById('clarificationEdit');
    var optimizationDetails = document.getElementById('optimizationDetails');
    var originalPromptDisplay = document.getElementById('originalPromptDisplay');
    var optimizedPromptDisplay = document.getElementById('optimizedPromptDisplay');

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
    var PREPARE_TIMEOUT = 20000;
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
    var healthPending = true;
    var optimizationReady = false;
    var optimizationAvailableText = '智能优化不可用，将按原始描述生成。';
    var activePhase = 'generate';
    var pendingOriginalSnapshot = null;
    var uncertainGeneration = false;

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
        stageClarification.hidden = name !== 'clarification';
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
        return activePhase === 'prepare' ? '正在理解并优化需求…' : '正在生成并保存…';
    }

    function syncControls() {
        var locked = isBusy || isReadingReferences;
        generateBtn.disabled = locked || healthPending || !serviceReady;
        generateLabel.textContent = isBusy ? activePhase === 'prepare' ? '正在优化需求…' : '生成中…' : isReadingReferences ? '正在读取图片…' : healthPending ? '正在检查服务…' : '生成图片';
        refInput.disabled = locked || references.length >= MAX_REFERENCES;
        if (refPick) refPick.setAttribute('aria-disabled', String(refInput.disabled));
        refClear.disabled = locked;
        asRefBtn.disabled = locked || references.length >= MAX_REFERENCES;
        againBtn.disabled = locked;
        errorRetry.disabled = locked;
        useOriginalBtn.disabled = locked || !pendingOriginalSnapshot || !serviceReady;
        clarificationEdit.disabled = locked;
        promptEl.disabled = locked;
        optimizeToggle.disabled = locked || !optimizationReady;
        refPreview.setAttribute('aria-busy', String(isReadingReferences));
        document.querySelectorAll('#refPreview .ref-remove, #sizeChips .size-chip, #presets .chip').forEach(function (button) { button.disabled = locked; });
        if (refCount) refCount.textContent = references.length + ' / ' + MAX_REFERENCES + ' 张' + (isReadingReferences ? ' · 正在读取…' : '');
        optimizeStatus.textContent = optimizationReady ? optimizeToggle.checked ? '仅整理文字需求，不上传参考图进行理解。' : '已关闭，将直接使用你的原始描述。' : optimizationAvailableText;
    }

    function showError(message) {
        setStage('error');
        errorText.textContent = message || '生成失败，请稍后重试';
        errorRetry.textContent = uncertainGeneration ? '重新生成（可能重复计费）' : '重新提交';
    }

    function invalidatePreparedInput() {
        pendingOriginalSnapshot = null;
        useOriginalBtn.hidden = true;
        useOriginalBtn.disabled = true;
        optimizationDetails.hidden = true;
    }

    /* ------------------------------ 提示词 ------------------------------ */
    function syncCharCount() {
        charCount.textContent = promptEl.value.length + ' / ' + MAX_PROMPT;
    }

    promptEl.addEventListener('input', function () {
        syncCharCount();
        invalidatePreparedInput();
    });
    promptEl.addEventListener('change', invalidatePreparedInput);
    optimizeToggle.addEventListener('change', function () {
        if (!optimizationReady) optimizeToggle.checked = false;
        invalidatePreparedInput();
        syncControls();
    });

    presetsEl.addEventListener('click', function (event) {
        var chip = event.target.closest('.chip');
        if (!chip || isBusy || isReadingReferences) return;
        invalidatePreparedInput();
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
        invalidatePreparedInput();
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
        invalidatePreparedInput();
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
        invalidatePreparedInput();
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
        invalidatePreparedInput();
        references = [];
        renderReferences();
    });

    refPreview.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-reference-index]');
        if (!button || !refPreview.contains(button) || isBusy || isReadingReferences) return;
        var index = Number(button.dataset.referenceIndex);
        if (!Number.isInteger(index) || index < 0 || index >= references.length) return;
        invalidatePreparedInput();
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
    function newRequestId() {
        if (!window.crypto || !window.crypto.getRandomValues) throw new Error('当前浏览器无法安全创建请求，请更新浏览器后重试');
        if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    function captureSnapshot(prompt) {
        return {
            prompt: prompt,
            inputPrompt: promptEl.value,
            size: currentSize,
            referenceImages: references.map(function (reference) { return reference.dataUrl; }),
            optimizationEnabled: optimizationReady && optimizeToggle.checked
        };
    }

    function snapshotMatches(snapshot) {
        return !!snapshot && promptEl.value === snapshot.inputPrompt && currentSize === snapshot.size &&
            (optimizationReady && optimizeToggle.checked) === snapshot.optimizationEnabled &&
            references.length === snapshot.referenceImages.length && references.every(function (reference, index) {
                return reference.dataUrl === snapshot.referenceImages[index];
            });
    }

    async function referenceHashes(snapshot) {
        var hashes = [];
        var encoder = new TextEncoder();
        for (var index = 0; index < snapshot.referenceImages.length; index++) {
            var digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(snapshot.referenceImages[index]));
            hashes.push(Array.from(new Uint8Array(digest), function (byte) { return byte.toString(16).padStart(2, '0'); }).join(''));
        }
        return hashes;
    }

    async function postJson(path, payload, timeout) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeout);
        try {
            var resp = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            var data = null;
            try { data = await resp.json(); } catch (error) {
                if (error && error.name === 'AbortError') throw error;
            }
            if (!resp.ok || !data || typeof data !== 'object') {
                var failure = new Error((data && typeof data.error === 'string' && data.error) || ('请求失败 HTTP ' + resp.status));
                failure.httpStatus = resp.status;
                failure.code = data && data.code;
                failure.allowOriginal = data && data.allowOriginal === true;
                throw failure;
            }
            return data;
        } catch (error) {
            if (error && error.httpStatus) throw error;
            var transportError = new Error(error && error.name === 'AbortError' ? path === '/api/image/prepare' ? '需求优化等待超时，尚未发起生图。' : '生成等待超时，结果尚未确认。服务可能仍在处理，请勿立即重复提交。' : path === '/api/image/prepare' ? '需求优化连接中断，尚未发起生图。' : '生图连接中断，结果尚未确认。服务可能仍在处理，请勿立即重复提交。');
            transportError.transport = true;
            throw transportError;
        } finally {
            clearTimeout(timer);
        }
    }

    function showOptimization(snapshot, prepared) {
        originalPromptDisplay.textContent = snapshot.prompt;
        optimizedPromptDisplay.textContent = prepared.optimizedPrompt;
        optimizationDetails.hidden = false;
    }

    function showResult(data, snapshot, prepared) {
        setStage('result');
        resultImg.src = data.url;
        downloadBtn.href = data.url;
        downloadBtn.setAttribute('download', 'qisao-' + Date.now() + '.png');
        resultPrompt.textContent = data.revisedPrompt ? '生图模型额外改写：' + data.revisedPrompt : snapshot.prompt;
        var entry = { url: data.url, prompt: snapshot.prompt, ts: Date.now() };
        if (prepared) {
            entry.originalPrompt = snapshot.prompt;
            entry.optimizedPrompt = prepared.optimizedPrompt;
            showOptimization(snapshot, prepared);
        }
        pushHistory(entry);
        uncertainGeneration = false;
    }

    function confirmNewGeneration() {
        return !uncertainGeneration || window.confirm('上一次生成可能仍在处理或已经计费。重新生成可能重复计费，是否继续？');
    }

    async function sendImage(snapshot, prepared) {
        if (!snapshotMatches(snapshot)) throw new Error('输入已变化，本次准备已取消，请重新生成。');
        var payload = {
            prompt: snapshot.prompt,
            size: snapshot.size,
            requestId: prepared ? prepared.preparationRequestId : newRequestId()
        };
        if (snapshot.referenceImages.length) payload.referenceImages = snapshot.referenceImages.slice();
        if (prepared) payload.optimizationToken = prepared.optimizationToken;
        activePhase = 'generate';
        syncControls();
        startTimer();
        try {
            var data = await postJson('/api/image', payload, REQUEST_TIMEOUT);
            if (data.status !== 'ok' || typeof data.url !== 'string' || !data.url) {
                var invalid = new Error(typeof data.error === 'string' ? data.error : '生成结果未确认，请勿盲目重试；重新生成可能重复计费。');
                invalid.uncertain = true;
                throw invalid;
            }
            showResult(data, snapshot, prepared);
        } catch (error) {
            if (error.transport || error.uncertain || error.httpStatus >= 500 || error.httpStatus === 409 || error.httpStatus < 400) uncertainGeneration = true;
            throw error;
        }
    }

    async function prepareImage(snapshot) {
        activePhase = 'prepare';
        syncControls();
        startTimer();
        var hashes = await referenceHashes(snapshot);
        if (!snapshotMatches(snapshot)) throw new Error('输入已变化，本次准备已取消，请重新生成。');
        var prepared;
        var preparationRequestId = newRequestId();
        try {
            prepared = await postJson('/api/image/prepare', {
                prompt: snapshot.prompt,
                size: snapshot.size,
                referenceHashes: hashes,
                requestId: preparationRequestId
            }, PREPARE_TIMEOUT);
        } catch (error) {
            var canUseOriginal = error.transport || ([502, 503, 504].indexOf(error.httpStatus) !== -1 && error.code === 'OPTIMIZATION_UNAVAILABLE' && error.allowOriginal);
            if (canUseOriginal && snapshotMatches(snapshot)) {
                pendingOriginalSnapshot = snapshot;
                useOriginalBtn.hidden = false;
                showError(error.message + '\n你可以修改后重新提交，或明确选择使用原词继续生成。');
                return null;
            }
            throw error;
        }
        if (!snapshotMatches(snapshot)) throw new Error('输入已变化，本次准备已取消，请重新生成。');
        if (prepared.status === 'needs_clarification') {
            if (typeof prepared.question !== 'string' || !prepared.question.trim()) throw new Error('智能优化未返回有效的补充问题，请修改描述后重新提交。');
            clarificationQuestion.textContent = prepared.question;
            setStage('clarification');
            return null;
        }
        if (prepared.status !== 'ready' || typeof prepared.optimizationToken !== 'string' || !prepared.optimizationToken ||
            prepared.originalPrompt !== snapshot.prompt || typeof prepared.optimizedPrompt !== 'string' || !prepared.optimizedPrompt.trim()) {
            throw new Error('优化结果与本次需求不一致，已停止生图，请重新提交。');
        }
        prepared.preparationRequestId = preparationRequestId;
        showOptimization(snapshot, prepared);
        return prepared;
    }

    async function generate() {
        if (isBusy || isReadingReferences || healthPending) return;
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
        if (!confirmNewGeneration()) return;

        invalidatePreparedInput();
        var snapshot = captureSnapshot(prompt);
        lastPrompt = prompt;
        activePhase = snapshot.optimizationEnabled ? 'prepare' : 'generate';
        setBusy(true);
        setStage('loading');

        try {
            var prepared = snapshot.optimizationEnabled ? await prepareImage(snapshot) : null;
            if (snapshot.optimizationEnabled && !prepared) return;
            await sendImage(snapshot, prepared);
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
        generate();
    });
    useOriginalBtn.addEventListener('click', async function () {
        if (isBusy || isReadingReferences || !pendingOriginalSnapshot) return;
        var snapshot = pendingOriginalSnapshot;
        if (!serviceReady || !snapshotMatches(snapshot)) {
            invalidatePreparedInput();
            showError('输入已变化或服务暂不可用，请重新提交当前需求。');
            return;
        }
        pendingOriginalSnapshot = null;
        useOriginalBtn.hidden = true;
        activePhase = 'generate';
        setBusy(true);
        setStage('loading');
        try {
            await sendImage(snapshot, null);
        } catch (error) {
            showError(error.message || '生成失败，请稍后重试');
        } finally {
            stopTimer();
            setBusy(false);
        }
    });
    clarificationEdit.addEventListener('click', function () {
        if (!isBusy && !isReadingReferences) promptEl.focus();
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
            var modeIsText = data.promptOptimizationMode === undefined || data.promptOptimizationMode === 'text';
            var secureFeatures = !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues && window.TextEncoder);
            optimizationReady = data.promptOptimizationReady === true && modeIsText && secureFeatures;
            if (data.promptOptimizationReady === true && !modeIsText) optimizationAvailableText = '当前优化模式暂不支持，将按原始描述生成。';
            else if (data.promptOptimizationReady === true && !secureFeatures) optimizationAvailableText = '智能优化需要 HTTPS 安全连接及新版浏览器；当前可直接使用原词生成。';
            optimizeToggle.checked = optimizationReady;
            if (typeof data.imageReady === 'boolean') serviceReady = data.imageReady;
            healthPending = false;
            setBusy(isBusy);
            if (serviceStatus && !serviceReady) {
                serviceStatus.hidden = false;
                serviceStatus.textContent = '生图服务尚未启用，请联系管理员配置。';
            }
        }).catch(function () {
            optimizationReady = false;
            optimizeToggle.checked = false;
            healthPending = false;
            syncControls();
        });

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
