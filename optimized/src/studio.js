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
    var clarificationHint = document.querySelector('#stageClarification small');
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
    var PENDING_JOB_KEY = 'qisao_studio_pending_job';
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
    var lastPrompt = '';
    var serviceReady = true;
    var healthPending = true;
    var optimizationReady = false;
    var optimizationAvailableText = '视觉优化不可用，将按原始描述生成。';
    var activePhase = 'generate';
    var pendingOriginalSnapshot = null;
    var uncertainGeneration = false;
    var jobsReady = false;
    var pendingJob = null;
    var jobSnapshot = null;
    var jobPolling = false;
    var jobPollTimer = null;
    var pendingNeedsUpload = false;
    var requiredReferenceUploadCount = 0;

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

    function setLoadingPhase(phase) {
        activePhase = phase;
        loadingText.textContent = phase === 'prepare' ? '正在优化视觉，完成后自动生成…' : '正在生成并保存…';
        syncControls();
    }

    function setBusy(busy) {
        isBusy = busy;
        syncControls();
    }

    function syncControls() {
        var locked = isBusy || isReadingReferences || !!pendingJob;
        generateBtn.disabled = locked || healthPending || !serviceReady;
        generateLabel.textContent = isBusy ? activePhase === 'prepare' ? '正在优化视觉…' : '生成中…' : isReadingReferences ? '正在读取图片…' : healthPending ? '正在检查服务…' : optimizationReady && optimizeToggle.checked ? '视觉优化并生成' : '生成图片';
        refInput.disabled = locked || references.length >= MAX_REFERENCES;
        if (refPick) refPick.setAttribute('aria-disabled', String(refInput.disabled));
        refClear.disabled = locked;
        asRefBtn.disabled = locked || references.length >= MAX_REFERENCES;
        againBtn.disabled = locked;
        errorRetry.disabled = pendingJob ? !pendingNeedsUpload || jobPolling : locked;
        useOriginalBtn.disabled = locked || !pendingOriginalSnapshot || !serviceReady;
        clarificationEdit.disabled = locked;
        promptEl.disabled = locked;
        optimizeToggle.disabled = locked || !optimizationReady;
        refPreview.setAttribute('aria-busy', String(isReadingReferences));
        document.querySelectorAll('#refPreview .ref-remove, #sizeChips .size-chip, #presets .chip').forEach(function (button) { button.disabled = locked; });
        if (refCount) refCount.textContent = references.length + ' / ' + MAX_REFERENCES + ' 张' + (isReadingReferences ? ' · 正在读取…' : pendingJob && !jobSnapshot && pendingJob.referenceCount ? ' · 后台任务已上传 ' + pendingJob.referenceCount + ' 张' : '');
        if (clarificationHint) clarificationHint.textContent = requiredReferenceUploadCount ? '此任务原有 ' + requiredReferenceUploadCount + ' 张参考图，请重新上传至少一张后再提交。尺寸已保留。' : references.length ? '参考图和尺寸已保留，请在上方描述中补充后重新生成。' : '尺寸已保留，请在上方描述中补充后重新生成。';
        optimizeStatus.textContent = optimizationReady ? optimizeToggle.checked ? '保留原意，完善构图、光线、色彩与质感；仅理解文字，不额外上传参考图。' : '已关闭视觉优化，将直接使用你的原始描述。' : optimizationAvailableText;
    }

    function showError(message) {
        setStage('error');
        errorText.textContent = message || '生成失败，请稍后重试';
        errorRetry.textContent = pendingNeedsUpload ? '继续上传原任务' : uncertainGeneration ? '重新生成（可能重复计费）' : '重新提交';
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
            requiredReferenceUploadCount = 0;
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
        var timer = timeout > 0 ? setTimeout(function () { controller.abort(); }, timeout) : null;
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
            var transportError = new Error(error && error.name === 'AbortError' ? path === '/api/image/prepare' ? '视觉优化等待超时，尚未发起生图。' : '生成等待超时，结果尚未确认。服务可能仍在处理，请勿立即重复提交。' : path === '/api/image/prepare' ? '视觉优化连接中断，尚未发起生图。' : '生图连接中断，结果尚未确认。服务可能仍在处理，请勿立即重复提交。');
            transportError.transport = true;
            throw transportError;
        } finally {
            if (timer !== null) clearTimeout(timer);
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

    function persistPendingJob() {
        localStorage.setItem(PENDING_JOB_KEY, JSON.stringify(pendingJob));
    }

    function clearJobPoll() {
        if (jobPollTimer !== null) clearTimeout(jobPollTimer);
        jobPollTimer = null;
    }

    function finishPendingJob() {
        clearJobPoll();
        try { localStorage.removeItem(PENDING_JOB_KEY); } catch (error) {}
        pendingJob = null;
        jobSnapshot = null;
        pendingNeedsUpload = false;
        setBusy(false);
    }

    function canResumeUpload() {
        return !!(pendingJob && !pendingJob.accepted && jobSnapshot && Date.now() - pendingJob.createdAt < 600000);
    }

    function scheduleJobPoll() {
        clearJobPoll();
        if (!pendingJob || pendingNeedsUpload || document.hidden) return;
        jobPollTimer = setTimeout(pollBackgroundJob, 2000);
    }

    async function jobRequest(path, method, payload, record) {
        var response = await fetch(path, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + record.token },
            body: payload ? JSON.stringify(payload) : undefined,
            cache: 'no-store',
            signal: AbortSignal.timeout(method === 'POST' ? 60000 : 10000)
        });
        var data;
        try { data = await response.json(); } catch (error) {}
        if (!response.ok || !data || data.status !== 'ok' || !data.job) {
            var failure = new Error(data && typeof data.error === 'string' ? data.error : '后台任务暂时无法连接，请稍后恢复查询。');
            failure.httpStatus = response.status;
            throw failure;
        }
        return data.job;
    }

    function applyJobState(job, record) {
        if (pendingJob !== record) return;
        var states = ['queued', 'optimizing', 'generating', 'succeeded', 'needs_clarification', 'failed', 'interrupted'];
        if (job.id !== record.id || states.indexOf(job.state) === -1 || job.originalPrompt !== record.prompt || job.size !== record.size || job.referenceCount !== record.referenceCount) {
            throw new Error('后台任务信息与本次需求不一致，已停止同步，请保留此页稍后重试。');
        }
        record.accepted = true;
        pendingNeedsUpload = false;
        try { persistPendingJob(); } catch (error) {}
        var snapshot = jobSnapshot || { prompt: record.prompt, inputPrompt: record.prompt, size: record.size, referenceImages: [], optimizationEnabled: record.optimizationEnabled };
        var prepared = null;
        if (job.optimization && job.optimization.originalPrompt === record.prompt && typeof job.optimization.optimizedPrompt === 'string' && job.optimization.optimizedPrompt.trim()) {
            prepared = job.optimization;
            showOptimization(snapshot, prepared);
        }
        if (job.state === 'queued' || job.state === 'optimizing' || job.state === 'generating') {
            setLoadingPhase(job.state === 'generating' ? 'generate' : record.optimizationEnabled ? 'prepare' : 'generate');
            loadingText.textContent = job.state === 'queued' ? '已提交后台，可切换应用或锁屏，返回后自动同步…' : job.state === 'optimizing' ? '后台正在优化视觉，完成后自动生成；可切换应用或锁屏…' : '后台正在生成并保存，可切换应用或锁屏，返回后自动同步…';
            setStage('loading');
            setBusy(true);
            return;
        }
        if (job.state === 'succeeded') {
            if (!job.result || typeof job.result.url !== 'string' || !job.result.url) throw new Error('后台结果暂未确认，正在继续同步，请勿重复提交。');
            showResult(job.result, snapshot, prepared);
            finishPendingJob();
            return;
        }
        var originalSnapshot = jobSnapshot;
        if (!originalSnapshot && record.referenceCount && !references.length) requiredReferenceUploadCount = record.referenceCount;
        var referenceReminder = !originalSnapshot && record.referenceCount ? '\n重新提交时请重新上传参考图，本设备不会保存参考图片。' : '';
        finishPendingJob();
        if (job.state === 'needs_clarification') {
            clarificationQuestion.textContent = (typeof job.question === 'string' && job.question.trim() ? job.question : '请补充主体和画面需求后重新提交。') + referenceReminder;
            setStage('clarification');
            return;
        }
        uncertainGeneration = job.state === 'interrupted' || job.state === 'failed' && job.code === 'IMAGE_GENERATION_UNKNOWN';
        if (job.allowOriginal === true && job.code === 'OPTIMIZATION_UNAVAILABLE' && originalSnapshot && snapshotMatches(originalSnapshot)) {
            pendingOriginalSnapshot = originalSnapshot;
            useOriginalBtn.hidden = false;
        }
        showError((typeof job.error === 'string' && job.error ? job.error : job.state === 'interrupted' ? '后台服务已重启，本次任务结果未确认，未自动重复生成。请先检查历史图片，再决定是否重新提交。' : '后台任务未完成，请调整描述或重新提交。') + referenceReminder);
        syncControls();
    }

    async function pollBackgroundJob() {
        clearJobPoll();
        if (!pendingJob || jobPolling || document.hidden) return;
        var record = pendingJob;
        jobPolling = true;
        try {
            applyJobState(await jobRequest('/api/image/jobs/' + encodeURIComponent(record.id), 'GET', null, record), record);
        } catch (error) {
            if (pendingJob !== record) return;
            if (error.httpStatus === 404) {
                if (canResumeUpload()) {
                    pendingNeedsUpload = true;
                    showError('尚未确认上传完成，服务器暂未找到任务。可继续上传同一个任务，不会主动新建重复任务。');
                } else {
                    uncertainGeneration = record.accepted;
                    if (!jobSnapshot && record.referenceCount && !references.length) requiredReferenceUploadCount = record.referenceCount;
                    finishPendingJob();
                    showError('后台任务已过期或无法找回，不会自动重新生成。请先检查最近生成；需要重新提交时请重新上传参考图。');
                }
            } else {
                loadingText.textContent = '连接暂时中断，后台任务可能仍在处理；保持此页或返回后会自动同步，请勿重复提交。';
                setStage('loading');
            }
        } finally {
            jobPolling = false;
            syncControls();
            scheduleJobPoll();
        }
    }

    async function uploadBackgroundJob() {
        if (!pendingJob || !jobSnapshot || jobPolling) return;
        var record = pendingJob;
        if (record.accepted || Date.now() - record.createdAt >= 600000) {
            pendingNeedsUpload = false;
            await pollBackgroundJob();
            return;
        }
        clearJobPoll();
        jobPolling = true;
        pendingNeedsUpload = false;
        setBusy(true);
        setStage('loading');
        loadingText.textContent = '正在上传，完成后可切到后台…';
        var payload = { requestId: record.id, prompt: jobSnapshot.prompt, size: jobSnapshot.size, optimize: jobSnapshot.optimizationEnabled };
        if (jobSnapshot.referenceImages.length) payload.referenceImages = jobSnapshot.referenceImages.slice();
        try {
            applyJobState(await jobRequest('/api/image/jobs', 'POST', payload, record), record);
        } catch (error) {
            if (pendingJob !== record) return;
            if (error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408) {
                uncertainGeneration = error.httpStatus === 409;
                finishPendingJob();
                showError(error.message || '任务未能提交，请重新检查输入。');
            } else {
                loadingText.textContent = '正在确认后台任务是否已接收，请勿重复提交…';
                setStage('loading');
            }
        } finally {
            jobPolling = false;
            syncControls();
            if (pendingJob === record) await pollBackgroundJob();
        }
    }

    async function startBackgroundJob(snapshot) {
        var tokenBytes = new Uint8Array(32);
        window.crypto.getRandomValues(tokenBytes);
        pendingJob = {
            id: newRequestId(),
            token: Array.from(tokenBytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join(''),
            createdAt: Date.now(),
            accepted: false,
            prompt: snapshot.prompt,
            size: snapshot.size,
            referenceCount: snapshot.referenceImages.length,
            optimizationEnabled: snapshot.optimizationEnabled
        };
        jobSnapshot = snapshot;
        try { persistPendingJob(); } catch (error) {
            pendingJob = null;
            jobSnapshot = null;
            throw new Error('浏览器无法保存后台任务凭据，尚未提交生成。请允许本站本地存储后重试。');
        }
        await uploadBackgroundJob();
    }

    function restorePendingJob() {
        try {
            var raw = localStorage.getItem(PENDING_JOB_KEY);
            if (!raw) return false;
            var record = JSON.parse(raw);
            if (!record || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) || !/^[0-9a-f]{64}$/.test(record.token) || typeof record.prompt !== 'string' || !record.prompt.trim() || record.prompt.length > MAX_PROMPT || ['auto', '1:1', '3:4', '4:3', '9:16', '16:9'].indexOf(record.size) === -1 || !Number.isInteger(record.referenceCount) || record.referenceCount < 0 || record.referenceCount > MAX_REFERENCES || !Number.isFinite(record.createdAt) || typeof record.accepted !== 'boolean' || typeof record.optimizationEnabled !== 'boolean') {
                localStorage.removeItem(PENDING_JOB_KEY);
                return false;
            }
            pendingJob = record;
            promptEl.value = record.prompt;
            lastPrompt = record.prompt;
            currentSize = record.size;
            sizeChips.querySelectorAll('.size-chip').forEach(function (chip) { chip.setAttribute('aria-pressed', String(chip.dataset.size === currentSize)); });
            if (sizeNote) sizeNote.textContent = currentSize === 'auto' ? '自动 · 模型自适应' : currentSize + ' · 2K';
            syncCharCount();
            setLoadingPhase(record.optimizationEnabled ? 'prepare' : 'generate');
            loadingText.textContent = '正在恢复后台任务，确认结果前不会重复生成…';
            setStage('loading');
            setBusy(true);
            return true;
        } catch (error) {
            return false;
        }
    }

    function wakeBackgroundJob() {
        if (!pendingJob || document.hidden) return;
        clearJobPoll();
        if (!pendingNeedsUpload) pollBackgroundJob();
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
        setLoadingPhase('generate');
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
        setLoadingPhase('prepare');
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
            }, 0);
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
            if (typeof prepared.question !== 'string' || !prepared.question.trim()) throw new Error('视觉优化未返回有效的补充问题，请修改描述后重新提交。');
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
        if (isBusy || pendingJob || isReadingReferences || healthPending) return;
        if (requiredReferenceUploadCount && !references.length) {
            showError('原任务有 ' + requiredReferenceUploadCount + ' 张参考图。请先重新上传至少一张参考图，再提交生成，避免误用纯文字生成。');
            return;
        }
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
        setLoadingPhase(snapshot.optimizationEnabled ? 'prepare' : 'generate');
        setBusy(true);
        setStage('loading');

        try {
            if (jobsReady) {
                await startBackgroundJob(snapshot);
                return;
            }
            var prepared = snapshot.optimizationEnabled ? await prepareImage(snapshot) : null;
            if (snapshot.optimizationEnabled && !prepared) return;
            await sendImage(snapshot, prepared);
        } catch (e) {
            showError(e && e.message ? e.message : '生成失败，请稍后重试');
        } finally {
            if (!pendingJob) setBusy(false);
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
        if (pendingJob) {
            if (pendingNeedsUpload && canResumeUpload()) uploadBackgroundJob();
            else pollBackgroundJob();
            return;
        }
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
        setLoadingPhase('generate');
        setBusy(true);
        setStage('loading');
        try {
            if (jobsReady) {
                await startBackgroundJob(Object.assign({}, snapshot, { optimizationEnabled: false }));
                return;
            }
            await sendImage(snapshot, null);
        } catch (error) {
            showError(error.message || '生成失败，请稍后重试');
        } finally {
            if (!pendingJob) setBusy(false);
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
        var hasPendingJob = restorePendingJob();
        if (hasPendingJob) pollBackgroundJob();

        fetch('/api/health', { signal: AbortSignal.timeout(8000) }).then(function (response) {
            if (!response.ok) throw new Error('Service unavailable');
            return response.json();
        }).then(function (data) {
            var modeIsText = data.promptOptimizationMode === undefined || data.promptOptimizationMode === 'text';
            var secureFeatures = !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues && window.TextEncoder);
            jobsReady = data.imageJobsReady === true && secureFeatures;
            optimizationReady = data.promptOptimizationReady === true && modeIsText && secureFeatures;
            if (data.promptOptimizationReady === true && !modeIsText) optimizationAvailableText = '当前视觉优化模式暂不支持，将按原始描述生成。';
            else if (data.promptOptimizationReady === true && !secureFeatures) optimizationAvailableText = '视觉优化需要 HTTPS 安全连接及新版浏览器；当前可直接使用原词生成。';
            optimizeToggle.checked = pendingJob ? pendingJob.optimizationEnabled : optimizationReady;
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
        if (seeded && !hasPendingJob) {
            promptEl.value = seeded.slice(0, MAX_PROMPT);
            syncCharCount();
        }

        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) clearJobPoll();
            else wakeBackgroundJob();
        });
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('pageshow', wakeBackgroundJob);
            window.addEventListener('online', wakeBackgroundJob);
            window.addEventListener('pagehide', clearJobPoll);
        }
    }

    init();
})();
