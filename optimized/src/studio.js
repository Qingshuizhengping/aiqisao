import { createStudioJobStore } from './studio-job-store.js';
import { createStudioJobController } from './studio-job-controller.js';
import { createReferenceCollection, createReferenceProcessor, MAX_REFERENCES } from './studio-reference-images.js';
import { createStudioHistoryStore } from './studio-history-store.js';
import { createStudioLegacyClient } from './studio-legacy-client.js';

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
    var MAX_HISTORY = 36;
    var MAX_PROMPT = 4000;

    var DEFAULT_SIZE = '1:1';
    var currentSize = DEFAULT_SIZE;
    var referenceCollection = createReferenceCollection();
    var referenceProcessor = createReferenceProcessor();
    var historyStore = createStudioHistoryStore({
        key: HISTORY_KEY, maxEntries: MAX_HISTORY,
        storage: {
            getItem: function (key) { return localStorage.getItem(key); },
            setItem: function (key, value) { localStorage.setItem(key, value); }
        }
    });
    var legacyClient = createStudioLegacyClient({ crypto: window.crypto, newRequestId: newRequestId });
    var historyNotice = null;
    var legacyActive = false;
    var deferredJobState = null;
    var unsavedLegacyResult = false;
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
    var jobSnapshots = new Map();
    var jobController = null;
    var jobState = { record: null, pending: [], outcome: null, network: 'idle', business: 'idle', issue: null };
    var renderedJobId = null;
    var renderedOutcomeSequence = 0;
    var recoveryLabel = null;
    var recoverySelect = null;
    var recoveryOptionsKey = '';
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

    function isWorking() {
        return isBusy || !!jobState.record;
    }

    function syncControls() {
        var locked = isWorking() || referenceCollection.reading;
        generateBtn.disabled = locked || healthPending || !serviceReady;
        generateLabel.textContent = isWorking() ? activePhase === 'prepare' ? '正在优化视觉…' : '生成中…' : referenceCollection.reading ? '正在读取图片…' : healthPending ? '正在检查服务…' : optimizationReady && optimizeToggle.checked ? '视觉优化并生成' : '生成图片';
        refInput.disabled = locked || referenceCollection.count >= MAX_REFERENCES;
        if (refPick) refPick.setAttribute('aria-disabled', String(refInput.disabled));
        refClear.disabled = locked;
        asRefBtn.disabled = locked || referenceCollection.count >= MAX_REFERENCES;
        againBtn.disabled = locked;
        errorRetry.disabled = jobState.record ? jobState.issue?.code !== 'UPLOAD_REQUIRED' || jobState.network !== 'idle' : locked;
        useOriginalBtn.disabled = locked || !pendingOriginalSnapshot || !serviceReady;
        clarificationEdit.disabled = locked;
        promptEl.disabled = locked;
        optimizeToggle.disabled = locked || !optimizationReady;
        refPreview.setAttribute('aria-busy', String(referenceCollection.reading));
        document.querySelectorAll('#refPreview .ref-remove, #sizeChips .size-chip, #presets .chip').forEach(function (button) { button.disabled = locked; });
        if (refCount) refCount.textContent = referenceCollection.count + ' / ' + MAX_REFERENCES + ' 张' + (referenceCollection.reading ? ' · 正在读取…' : jobState.record && !jobSnapshots.has(jobState.record.id) && jobState.record.referenceCount ? ' · 后台任务已上传 ' + jobState.record.referenceCount + ' 张' : '');
        if (clarificationHint) clarificationHint.textContent = requiredReferenceUploadCount ? '此任务原有 ' + requiredReferenceUploadCount + ' 张参考图，请重新上传至少一张后再提交。尺寸已保留。' : referenceCollection.count ? '参考图和尺寸已保留，请在上方描述中补充后重新生成。' : '尺寸已保留，请在上方描述中补充后重新生成。';
        optimizeStatus.textContent = optimizationReady ? optimizeToggle.checked ? '保留原意，完善构图、光线、色彩与质感；仅理解文字，不额外上传参考图。' : '已关闭视觉优化，将直接使用你的原始描述。' : optimizationAvailableText;
    }

    function showError(message) {
        setStage('error');
        errorText.textContent = message || '生成失败，请稍后重试';
        errorRetry.textContent = jobState.issue?.code === 'UPLOAD_REQUIRED' ? '继续上传原任务' : uncertainGeneration ? '重新生成（可能重复计费）' : '重新提交';
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
        if (!chip || isWorking() || referenceCollection.reading) return;
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
        if (!chip || isWorking() || referenceCollection.reading) return;
        invalidatePreparedInput();
        var chips = sizeChips.querySelectorAll('.size-chip');
        for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', String(chips[i] === chip));
        currentSize = chip.dataset.size || DEFAULT_SIZE;
        if (sizeNote) sizeNote.textContent = currentSize === 'auto' ? '自动 · 模型自适应' : currentSize + ' · 2K';
    });

    /* ------------------------------ 参考图 ------------------------------ */
    function renderReferences() {
        var has = referenceCollection.count > 0;
        var fragment = document.createDocumentFragment();
        referenceCollection.list().forEach(function (reference, index) {
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
        if (isWorking() || referenceCollection.reading || !items.length) return false;
        invalidatePreparedInput();
        var operation = referenceCollection.append(items, prepare);
        syncControls();
        var result = await operation;
        if (result.ok) requiredReferenceUploadCount = 0;
        else if (result.error) showError(result.error.message || '参考图读取失败，换一张试试');
        renderReferences();
        return result.ok;
    }

    refInput.addEventListener('change', async function () {
        var files = Array.from(refInput.files || []);
        try {
            await appendReferences(files, referenceProcessor.fromFile);
        } finally {
            refInput.value = '';
        }
    });

    refClear.addEventListener('click', function () {
        if (isWorking() || referenceCollection.reading) return;
        invalidatePreparedInput();
        referenceCollection.replace([]);
        renderReferences();
    });

    refPreview.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-reference-index]');
        if (!button || !refPreview.contains(button) || isWorking() || referenceCollection.reading) return;
        var index = Number(button.dataset.referenceIndex);
        if (!Number.isInteger(index) || index < 0 || index >= referenceCollection.count) return;
        invalidatePreparedInput();
        referenceCollection.remove(index);
        renderReferences();
    });

    /* ------------------------------ 历史 ------------------------------ */
    function showHistoryNotice(message) {
        historyNotice = message;
        if (serviceStatus) {
            serviceStatus.hidden = false;
            serviceStatus.textContent = message;
        }
    }

    function clearHistoryNotice() {
        if (serviceStatus && serviceStatus.textContent === historyNotice) {
            serviceStatus.hidden = true;
            serviceStatus.textContent = '';
        }
        historyNotice = null;
    }

    function loadHistory() {
        var result = historyStore.load();
        history = result.entries;
        if (!result.ok) showHistoryNotice('本地历史暂时无法读取，原有记录未被覆盖。');
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
        var result = historyStore.append(entry);
        history = result.entries;
        renderHistory();
        return result.ok;
    }

    historyClear.addEventListener('click', function () {
        if (!history.length) return;
        var result = historyStore.clear();
        history = result.entries;
        if (result.ok) clearHistoryNotice();
        else showHistoryNotice('历史清空失败，记录仍保留，请稍后重试。');
        renderHistory();
    });

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
            referenceImages: referenceCollection.list().map(function (reference) { return reference.dataUrl; }),
            optimizationEnabled: optimizationReady && optimizeToggle.checked
        };
    }

    function snapshotMatches(snapshot) {
        return !!snapshot && promptEl.value === snapshot.inputPrompt && currentSize === snapshot.size &&
            (optimizationReady && optimizeToggle.checked) === snapshot.optimizationEnabled &&
            referenceCollection.count === snapshot.referenceImages.length && referenceCollection.list().every(function (reference, index) {
                return reference.dataUrl === snapshot.referenceImages[index];
            });
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
        var saved = pushHistory(entry);
        uncertainGeneration = false;
        return saved;
    }

    function consumeResult(data, snapshot, prepared, acknowledge) {
        var saved = showResult(data, snapshot, prepared);
        if (saved) {
            clearHistoryNotice();
            if (acknowledge) acknowledge();
        } else {
            showHistoryNotice('图片已生成，但本地历史保存失败。请先下载图片' +
                (acknowledge ? '；恢复凭据已保留，可通过后台任务重新同步。' : '，避免关闭页面后丢失。'));
        }
        return saved;
    }

    function confirmNewGeneration() {
        return !uncertainGeneration || window.confirm('上一次生成可能仍在处理或已经计费。重新生成可能重复计费，是否继续？');
    }

    function backgroundSnapshot(record) {
        return jobSnapshots.get(record.id) || { prompt: record.prompt, inputPrompt: record.prompt, size: record.size, referenceImages: [], optimizationEnabled: record.optimizationEnabled };
    }

    function preparedForJob(job, record) {
        return job?.optimization && job.optimization.originalPrompt === record.prompt && typeof job.optimization.optimizedPrompt === 'string' && job.optimization.optimizedPrompt.trim() ? job.optimization : null;
    }

    function renderRecoveryQueue(state) {
        if (!recoverySelect) return;
        recoverySelect.disabled = legacyActive;
        var optionsKey = JSON.stringify([state.record?.id, state.pending.map(function (record) { return [record.id, record.prompt]; })]);
        if (optionsKey === recoveryOptionsKey) return;
        recoveryOptionsKey = optionsKey;
        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = state.pending.length ? '选择待恢复任务（' + state.pending.length + '）' : '没有待恢复任务';
        var options = [placeholder];
        state.pending.forEach(function (record) {
            var option = document.createElement('option');
            option.value = record.id;
            option.textContent = record.prompt.slice(0, 36) + (record.prompt.length > 36 ? '…' : '');
            options.push(option);
        });
        recoverySelect.replaceChildren.apply(recoverySelect, options);
        recoverySelect.value = state.record ? state.record.id : '';
        recoveryLabel.hidden = state.pending.length < 2 && !!state.record || !state.pending.length;
    }

    function renderJobOutcome(outcome) {
        var record = outcome.record;
        var job = outcome.job;
        var originalSnapshot = jobSnapshots.get(record.id);
        var snapshot = backgroundSnapshot(record);
        var prepared = preparedForJob(job, record);
        var referenceReminder = !originalSnapshot && record.referenceCount ? '\n重新提交时请重新上传参考图，本设备不会保存参考图片。' : '';
        jobSnapshots.delete(record.id);
        isBusy = false;
        if (job.state === 'succeeded') {
            consumeResult(job.result, snapshot, prepared, function () {
                jobController.acknowledge(outcome.sequence);
            });
            return;
        }
        if (!originalSnapshot && record.referenceCount && !referenceCollection.count) requiredReferenceUploadCount = record.referenceCount;
        if (prepared) showOptimization(snapshot, prepared);
        if (job.state === 'needs_clarification') {
            clarificationQuestion.textContent = (typeof job.question === 'string' && job.question.trim() ? job.question : '请补充主体和画面需求后重新提交。') + referenceReminder;
            setStage('clarification');
            jobController.acknowledge(outcome.sequence);
            return;
        }
        uncertainGeneration = outcome.uncertain;
        if (job.allowOriginal === true && job.code === 'OPTIMIZATION_UNAVAILABLE' && originalSnapshot && snapshotMatches(originalSnapshot)) {
            pendingOriginalSnapshot = originalSnapshot;
            useOriginalBtn.hidden = false;
        }
        showError((typeof job.error === 'string' && job.error ? job.error : job.state === 'interrupted' ? '后台服务已重启，本次任务结果未确认，未自动重复生成。请先检查历史图片，再决定是否重新提交。' : '后台任务未完成，请调整描述或重新提交。') + referenceReminder);
        jobController.acknowledge(outcome.sequence);
    }

    function renderJobState(state) {
        if (legacyActive || unsavedLegacyResult) {
            deferredJobState = state;
            renderRecoveryQueue(Object.assign({}, state, { record: null }));
            return;
        }
        jobState = state;
        renderRecoveryQueue(state);
        var record = state.record;
        if (record) {
            var snapshot = backgroundSnapshot(record);
            if (renderedJobId !== record.id) {
                renderedJobId = record.id;
                invalidatePreparedInput();
                requiredReferenceUploadCount = 0;
                promptEl.value = snapshot.inputPrompt;
                lastPrompt = record.prompt;
                currentSize = record.size;
                optimizeToggle.checked = record.optimizationEnabled;
                referenceCollection.replace(snapshot.referenceImages.map(function (dataUrl, index) {
                    return { dataUrl: dataUrl, name: snapshot.referenceNames?.[index] || '参考图 ' + (index + 1) };
                }));
                renderReferences();
                sizeChips.querySelectorAll('.size-chip').forEach(function (chip) { chip.setAttribute('aria-pressed', String(chip.dataset.size === currentSize)); });
                if (sizeNote) sizeNote.textContent = currentSize === 'auto' ? '自动 · 模型自适应' : currentSize + ' · 2K';
                syncCharCount();
            }
            setLoadingPhase(state.business === 'generating' ? 'generate' : record.optimizationEnabled ? 'prepare' : 'generate');
            var prepared = preparedForJob(state.job, record);
            if (prepared) showOptimization(snapshot, prepared);
            if (state.issue?.code === 'UPLOAD_REQUIRED') {
                showError(state.issue.message);
            } else {
                loadingText.textContent = state.network === 'uploading' ? '正在上传，完成后可切到后台…' :
                    state.network === 'offline' ? '连接暂时中断，后台任务可能仍在处理；保持此页或返回后会自动同步，请勿重复提交。' :
                    state.issue?.code === 'UPLOAD_UNCONFIRMED' ? state.issue.message :
                    state.business === 'queued' ? '已提交后台，可切换应用或锁屏，返回后自动同步…' :
                    state.business === 'optimizing' ? '后台正在优化视觉，完成后自动生成；可切换应用或锁屏…' :
                    state.business === 'generating' ? '后台正在生成并保存，可切换应用或锁屏，返回后自动同步…' :
                    '正在恢复后台任务，确认结果前不会重复生成…';
                setStage('loading');
            }
        } else if (state.outcome && state.outcome.sequence !== renderedOutcomeSequence) {
            renderedOutcomeSequence = state.outcome.sequence;
            renderJobOutcome(state.outcome);
            renderedJobId = null;
        }
        syncControls();
    }

    async function startBackgroundJob(snapshot) {
        var record = jobController.create(snapshot);
        jobSnapshots.set(record.id, Object.assign({}, snapshot, { referenceNames: referenceCollection.list().map(function (reference) { return reference.name; }) }));
        await jobController.upload(record.id);
    }

    function initializeBackgroundJobs() {
        recoveryLabel = document.createElement('label');
        recoveryLabel.className = 'studio-hint studio-recovery';
        recoveryLabel.textContent = '后台任务 ';
        recoverySelect = document.createElement('select');
        recoverySelect.className = 'chip';
        recoverySelect.setAttribute('aria-label', '选择需要恢复的后台任务');
        recoverySelect.addEventListener('change', function () {
            if (legacyActive || !recoverySelect.value) return;
            unsavedLegacyResult = false;
            deferredJobState = null;
            jobController.activate(recoverySelect.value);
        });
        recoveryLabel.appendChild(recoverySelect);
        if (serviceStatus?.parentElement) serviceStatus.parentElement.appendChild(recoveryLabel);
        var storage = {
            getItem: function (key) { return localStorage.getItem(key); },
            setItem: function (key, value) { localStorage.setItem(key, value); },
            removeItem: function (key) { localStorage.removeItem(key); },
            key: function (index) { return localStorage.key(index); },
            get length() { return localStorage.length; }
        };
        jobController = createStudioJobController({
            store: createStudioJobStore(storage),
            getSnapshot: function (id) { return jobSnapshots.get(id); },
            cryptoImpl: window.crypto,
            documentTarget: document,
            windowTarget: window
        });
        jobController.subscribe(renderJobState);
        jobController.start();
        return !!jobState.record;
    }

    async function sendImage(snapshot, prepared) {
        setLoadingPhase('generate');
        try {
            var outcome = await legacyClient.generate(snapshot, prepared, {
                isCurrent: function () { return snapshotMatches(snapshot); }
            });
            unsavedLegacyResult = !consumeResult(outcome.result, snapshot, prepared);
        } catch (error) {
            if (error.uncertain) uncertainGeneration = true;
            throw error;
        }
    }

    async function prepareImage(snapshot) {
        setLoadingPhase('prepare');
        var outcome;
        try {
            outcome = await legacyClient.prepare(snapshot, {
                isCurrent: function () { return snapshotMatches(snapshot); }
            });
        } catch (error) {
            if (error.allowOriginal && snapshotMatches(snapshot)) {
                pendingOriginalSnapshot = snapshot;
                useOriginalBtn.hidden = false;
                showError(error.message + '\n你可以修改后重新提交，或明确选择使用原词继续生成。');
                return null;
            }
            throw error;
        }
        if (outcome.state === 'needs_clarification') {
            clarificationQuestion.textContent = outcome.question;
            setStage('clarification');
            return null;
        }
        showOptimization(snapshot, outcome.prepared);
        return outcome.prepared;
    }

    function beginLegacyOperation() {
        legacyActive = true;
        renderRecoveryQueue(jobState);
    }

    function finishLegacyOperation() {
        legacyActive = false;
        setBusy(false);
        if (deferredJobState) {
            var state = deferredJobState;
            deferredJobState = null;
            renderJobState(state);
        } else {
            renderRecoveryQueue(jobState);
        }
    }

    async function generate() {
        if (isWorking() || referenceCollection.reading || healthPending) return;
        if (requiredReferenceUploadCount && !referenceCollection.count) {
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

        unsavedLegacyResult = false;
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
            beginLegacyOperation();
            var prepared = snapshot.optimizationEnabled ? await prepareImage(snapshot) : null;
            if (snapshot.optimizationEnabled && !prepared) return;
            await sendImage(snapshot, prepared);
        } catch (e) {
            showError(e && e.message ? e.message : '生成失败，请稍后重试');
        } finally {
            if (legacyActive) finishLegacyOperation();
            else setBusy(false);
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
        if (jobState.record) {
            jobController.retry();
            return;
        }
        generate();
    });
    useOriginalBtn.addEventListener('click', async function () {
        if (isWorking() || referenceCollection.reading || !pendingOriginalSnapshot) return;
        var snapshot = pendingOriginalSnapshot;
        if (!serviceReady || !snapshotMatches(snapshot)) {
            invalidatePreparedInput();
            showError('输入已变化或服务暂不可用，请重新提交当前需求。');
            return;
        }
        pendingOriginalSnapshot = null;
        useOriginalBtn.hidden = true;
        unsavedLegacyResult = false;
        setLoadingPhase('generate');
        setBusy(true);
        setStage('loading');
        try {
            if (jobsReady) {
                await startBackgroundJob(Object.assign({}, snapshot, { optimizationEnabled: false }));
                return;
            }
            beginLegacyOperation();
            await sendImage(snapshot, null);
        } catch (error) {
            showError(error.message || '生成失败，请稍后重试');
        } finally {
            if (legacyActive) finishLegacyOperation();
            else setBusy(false);
        }
    });
    clarificationEdit.addEventListener('click', function () {
        if (!isWorking() && !referenceCollection.reading) promptEl.focus();
    });

    resultImg.addEventListener('click', function () { openLightbox(resultImg.src); });

    // 把结果当参考图，走图生图继续改
    asRefBtn.addEventListener('click', async function () {
        var url = resultImg.getAttribute('src');
        if (!url || isWorking() || referenceCollection.reading) return;
        var added = await appendReferences([url], referenceProcessor.fromUrl);
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
        var hasPendingJob = initializeBackgroundJobs();

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
            optimizeToggle.checked = jobState.record ? jobState.record.optimizationEnabled : optimizationReady;
            if (typeof data.imageReady === 'boolean') serviceReady = data.imageReady;
            if (data.imageJobsStatus?.code === 'IMAGE_JOB_STORAGE_UNAVAILABLE') serviceReady = false;
            healthPending = false;
            setBusy(isBusy);
            if (serviceStatus && !serviceReady) {
                serviceStatus.hidden = false;
                serviceStatus.textContent = data.imageJobsStatus?.code === 'IMAGE_JOB_STORAGE_UNAVAILABLE' ? '后台任务存储异常，已暂停新生成；已有任务仍会继续查询，请稍后重试。' : '生图服务尚未启用，请联系管理员配置。';
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
    }

    init();
})();
