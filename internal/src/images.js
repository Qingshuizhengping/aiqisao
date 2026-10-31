/**
 * @file 素材生成面板 (requirement R2-01/04/07 frontend).
 *
 * Self-contained modal: it owns its polling interval and clears it when the panel closes.
 * Closing the panel never cancels a job — the task lives in SQLite, so reopening the panel
 * (or reloading the page) picks the "生成中" state back up from `GET /api/images/jobs`.
 *
 * Size presets come from `GET /api/images/options`; the browser never decides a resolution
 * on its own, and every error text comes from a backend `error.code` mapping.
 */

import { api, downloadFile } from './api.js';
import { el, button, input, panel, notice, empty, badge, formatDate } from './ui.js';

/** Poll cadence for job state (the label ticker runs faster, see `TICK_MS`). */
export const POLL_MS = 2000;
/** Label/elapsed refresh cadence; polling is throttled to POLL_MS inside the same timer. */
const TICK_MS = 1000;
/** First screen of history plus the "查看全部" step. */
export const HISTORY_PAGE = 12;
/** After this long we tell the member the task can be left running, without cancelling it. */
export const WAIT_HINT_MS = 200000;

/** 5 prompt templates (wording follows the reference implementation). */
export const TEMPLATES = Object.freeze([
    { key: 'flat', label: '产品平铺', prompt: '产品平铺在白底上，柔和顶光，干净背景，突出包装细节与质感，商业摄影风格' },
    { key: 'poster', label: '海报竖版', prompt: '竖版品牌海报，留出上方文字空间，柔和自然光，高级质感的调肤主题，画面干净克制' },
    { key: 'patch', label: '贴片背景', prompt: '简约贴片背景，柔和渐变与细微光影，中间留白放置文字，适合门店活动物料' },
    { key: 'store', label: '门店场景', prompt: '温馨的门店护理空间，木色与浅绿配色，午后自然光，真实生活感，突出专业与放松' },
    { key: 'portrait', label: '人物氛围', prompt: '年轻女性在店内做皮肤咨询，自然表情，柔和光线，真实场景氛围，构图留白' },
]);

/**
 * User facing text per backend error code. Nothing else may reach the notice: the upstream
 * body can contain prompt fragments or diagnostics.
 */
export const ERROR_TEXT = Object.freeze({
    IMAGE_UPSTREAM_QUOTA: '生图服务额度未开通，请联系管理员',
    IMAGE_UPSTREAM_AUTH: '生图服务鉴权失败，请联系管理员',
    IMAGE_CONTENT_BLOCKED: '这段描述未通过内容安全检查，换个说法再试',
    IMAGE_UPSTREAM_BUSY: '现在排队的人多，等一会儿再点',
    IMAGE_UPSTREAM_ERROR: '生图服务暂时不可用，稍后重试',
    IMAGE_RESULT_UNKNOWN: '这张可能已经生成并计费了，别急着重试——先刷新历史看一眼',
    IMAGE_JOB_INTERRUPTED: '服务重启中断了任务，未自动重新提交；请先看历史确认是否已生成',
    IMAGE_JOB_CANCELLED: '任务排队时服务重启，未提交，可安全重试',
    IMAGE_RATE_LIMITED: '生成太频繁了，请稍后再试（每分钟 5 次、每小时 30 次）',
    IMAGE_QUEUE_FULL: '生成任务较多，请稍后再试',
    IMAGE_NOT_CONFIGURED: '生图服务未配置，请联系管理员',
    INVALID_IMAGE_INPUT: '请填写 4000 字以内的描述，并选择支持的尺寸。',
    IMAGE_REQUEST_ID_CONFLICT: '这次请求和上一次冲突了，请重新提交。',
    IMAGE_NOT_READY: '图片还没有生成完成。',
    IMAGE_FILE_MISSING: '图片文件已不存在，请重新生成。',
    IMAGE_JOB_NOT_FOUND: '素材不存在。',
});

/**
 * @param {string} code Backend error code.
 * @param {string} [fallback] Backend message (already user facing).
 * @returns {string} Text to show.
 */
export function errorText(code, fallback = '') {
    return ERROR_TEXT[code] || fallback || '生成没有完成，请稍后重试。';
}

/** @returns {string} UUID used as the idempotency key of one generation attempt. */
function requestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
        const value = (Math.random() * 16) | 0;
        return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
    });
}

/** @param {number} milliseconds Elapsed time. @returns {string} "12 秒" / "1 分 05 秒". */
function duration(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return seconds + ' 秒';
    return Math.floor(seconds / 60) + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒';
}

/**
 * Opens the 素材生成 panel.
 *
 * @returns {{dialog: HTMLDialogElement, close: Function}} Panel handle.
 */
export function openImagesPanel() {
    const errors = el('div', { className: 'image-errors' });
    const promptField = input('画面描述', { tag: 'textarea', maxlength: 4000, rows: 3,
        placeholder: '例如：产品平铺在浅色台面上，柔和自然光，突出包装质感' });
    promptField.control.classList.add('image-prompt');
    const templateRow = el('div', { className: 'image-templates', role: 'group', 'aria-label': '提示词模板' });
    const sizeRow = el('div', { className: 'image-sizes', role: 'group', 'aria-label': '画面尺寸' });
    const sizeNote = el('small', { className: 'image-size-note', text: '「自动」由模型决定构图' });
    const generateLabel = el('span', { text: '开始生成' });
    const generateButton = button('', () => submit(), { className: 'button primary image-generate', glyph: 'spark', name: '开始生成' });
    generateButton.append(generateLabel);
    const resultHost = el('div', { className: 'image-result' });
    const historyHost = el('div', { className: 'image-grid' });
    const historyFooter = el('div', { className: 'image-history-footer' });
    const body = el('div', { className: 'image-panel' },
        el('section', { className: 'image-section' },
            el('h3', { text: '想生成什么' }), promptField.wrapper, templateRow, errors,
            el('div', { className: 'image-submit' }, generateButton)),
        el('section', { className: 'image-section' }, el('h3', { text: '尺寸' }), sizeRow, sizeNote),
        el('section', { className: 'image-section' }, el('h3', { text: '生成结果' }), resultHost),
        el('section', { className: 'image-section' },
            el('div', { className: 'row-between' }, el('h3', { text: '我的历史' }),
                el('small', { className: 'muted', text: '只显示你自己的素材' })), historyHost, historyFooter));
    const view = panel('素材生成', body, { wide: true, subtitle: '描述画面即可生成素材；关闭面板不会中断生成。' });

    let sizes = [];
    let sizeKey = '1:1';
    let active = null;
    let busy = false;
    let timer = null;
    let lastPoll = 0;
    let cursor = null;
    let disposed = false;
    /** @type {Map<string, Object>} jobId -> latest job view. */
    const seen = new Map();
    const PENDING = ['queued', 'running'];

    function renderTemplates() {
        const current = promptField.control.value;
        templateRow.replaceChildren(...TEMPLATES.map(template => {
            const selected = current === template.prompt;
            return button(template.label, () => {
                promptField.control.value = template.prompt;
                renderTemplates();
                promptField.control.focus();
            }, { className: 'chip' + (selected ? ' active' : ''), 'aria-pressed': String(selected) });
        }));
    }

    function renderSizes() {
        sizeRow.replaceChildren(...sizes.map(option => button(option.label, () => {
            sizeKey = option.key;
            renderSizes();
        }, { className: 'chip size-chip' + (sizeKey === option.key ? ' active' : ''),
            'aria-pressed': String(sizeKey === option.key), title: option.size || '由模型决定构图',
            disabled: generateButton.disabled })));
    }

    function setControlsDisabled(disabled) {
        promptField.control.disabled = disabled;
        generateButton.disabled = disabled;
        for (const chip of templateRow.querySelectorAll('button')) chip.disabled = disabled;
        for (const chip of sizeRow.querySelectorAll('button')) chip.disabled = disabled;
    }

    function waitingLabel(job) {
        const elapsed = Date.now() - Number(job.createdAt || Date.now());
        if (elapsed > WAIT_HINT_MS) return '仍在生成，可关闭面板稍后回看';
        return '生成中…（已等待 ' + duration(elapsed) + '）';
    }

    function renderResult() {
        if (!active) {
            resultHost.replaceChildren(empty('还没有生成任务', '写清楚画面和尺寸，点“开始生成”。'));
            return;
        }
        const job = seen.get(active.id);
        if (!job || PENDING.includes(job.state)) {
            resultHost.replaceChildren(el('div', { className: 'image-wait' },
                el('div', { className: 'loading-line' }),
                el('p', { text: job ? waitingLabel(job) : '正在生成…' }),
                el('small', { className: 'muted', text: '任务在后台继续，关闭面板不会中断。' })));
            return;
        }
        if (job.state === 'failed') {
            resultHost.replaceChildren(notice(errorText(job.error?.code, job.error?.message), 'error'),
                button('再试一次', () => { submit(job.prompt); }, { className: 'button small' }));
            return;
        }
        resultHost.replaceChildren(el('figure', { className: 'image-figure' },
            el('img', { className: 'image-result-img', src: job.image.url, alt: job.prompt || '生成的素材' }),
            el('figcaption', {},
                el('div', { className: 'row-between' }, badge(job.sizeKey, 'accent'),
                    el('small', { className: 'muted', text: formatDate(job.createdAt) })),
                el('small', { className: 'image-prompt-copy', text: job.prompt }),
                el('div', { className: 'image-actions' },
                    button('下载', () => download(job), { glyph: 'arrow', className: 'button small' }),
                    button('再生成', () => { submit(job.prompt); }, { glyph: 'spark', className: 'button small' })))));
    }

    function renderHistory() {
        const jobs = [...seen.values()].sort((left, right) => right.createdAt - left.createdAt);
        if (!jobs.length) {
            historyHost.replaceChildren(empty('还没有历史素材', '生成后会自动保存在这里。'));
            historyFooter.replaceChildren();
            return;
        }
        historyHost.replaceChildren(...jobs.slice(0, Number.MAX_SAFE_INTEGER).map(job => el('button', {
            type: 'button', className: 'image-thumb' + (active?.id === job.id ? ' active' : ''),
            title: job.prompt || '素材', onclick: () => select(job),
        }, job.state === 'succeeded'
            ? el('img', { src: job.image.url, alt: job.prompt || '素材', loading: 'lazy' })
            : el('span', { className: 'image-thumb-state', text: job.state === 'failed' ? '失败' : '生成中' }))));
        historyFooter.replaceChildren(cursor
            ? button('查看全部', () => loadHistory(cursor), { className: 'button small image-history-more' })
            : '');
    }

    function select(job) {
        seen.set(job.id, job);
        active = { id: job.id, createdAt: job.createdAt, state: job.state };
        if (job.prompt) promptField.control.value = job.prompt;
        if (job.sizeKey) sizeKey = job.sizeKey;
        renderTemplates();
        renderSizes();
        renderResult();
        renderHistory();
        if (PENDING.includes(job.state)) startTimer();
    }

    function remember(job) {
        seen.set(job.id, job);
        if (!active || active.id !== job.id) { renderHistory(); return; }
        active = { id: job.id, createdAt: job.createdAt, state: job.state };
        if (PENDING.includes(job.state)) {
            generateLabel.textContent = waitingLabel(job);
            renderResult();
            return;
        }
        stopTimer();
        setControlsDisabled(false);
        generateLabel.textContent = '开始生成';
        renderResult();
        renderHistory();
    }

    function stopTimer() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function startTimer() {
        if (timer || disposed) return;
        lastPoll = 0;
        timer = setInterval(async () => {
            if (disposed || !active) { stopTimer(); return; }
            if (!PENDING.includes(active.state)) { stopTimer(); return; }
            generateLabel.textContent = waitingLabel(active);
            const waiting = seen.get(active.id);
            if (waiting) renderResult();
            if (Date.now() - lastPoll < POLL_MS) return;
            lastPoll = Date.now();
            try {
                const data = await api('/api/images/jobs/' + encodeURIComponent(active.id));
                if (disposed) return;
                remember(data.job);
            } catch (error) {
                if (disposed || error.code === 'STALE_RESPONSE') return;
                errors.replaceChildren(notice(errorText(error.code, error.message), 'error'));
                stopTimer();
                setControlsDisabled(false);
            }
        }, TICK_MS);
    }

    async function loadHistory(before) {
        try {
            const data = await api('/api/images/jobs?limit=' + HISTORY_PAGE
                + (before ? '&before=' + encodeURIComponent(before) : ''));
            if (disposed) return;
            const jobs = Array.isArray(data.jobs) ? data.jobs : [];
            for (const job of jobs) seen.set(job.id, job);
            const oldest = jobs.at(-1);
            cursor = data.hasMore && oldest ? oldest.createdAt : null;
            if (!before) {
                // Reopening the panel resumes a job that is still running elsewhere.
                const pending = jobs.find(job => PENDING.includes(job.state));
                if (pending) {
                    active = { id: pending.id, createdAt: pending.createdAt, state: pending.state };
                    setControlsDisabled(true);
                    generateLabel.textContent = waitingLabel(pending);
                    startTimer();
                }
            }
            renderResult();
            renderHistory();
        } catch (error) {
            if (disposed || error.code === 'STALE_RESPONSE') return;
            errors.replaceChildren(notice(errorText(error.code, error.message), 'error'));
        }
    }

    async function download(job) {
        try {
            const file = await downloadFile(job.image.url);
            const url = URL.createObjectURL(file);
            const anchor = el('a', { href: url, download: job.image.fileName || '素材.png' });
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (error) {
            errors.replaceChildren(notice(errorText(error.code, error.message), 'error'));
        }
    }

    async function submit(promptOverride) {
        if (busy || disposed) return;
        if (typeof promptOverride === 'string' && promptOverride) promptField.control.value = promptOverride;
        const prompt = promptField.control.value.trim();
        if (!prompt) {
            errors.replaceChildren(notice('请先写清楚想生成什么。', 'error'));
            promptField.control.focus();
            return;
        }
        busy = true;
        errors.replaceChildren();
        setControlsDisabled(true);
        generateLabel.textContent = '正在提交…';
        try {
            const data = await api('/api/images/jobs', { method: 'POST', body: { prompt, size: sizeKey, requestId: requestId() } });
            if (disposed) return;
            seen.set(data.job.id, data.job);
            active = { id: data.job.id, createdAt: data.job.createdAt, state: data.job.state };
            renderResult();
            renderHistory();
            if (PENDING.includes(data.job.state)) {
                generateLabel.textContent = waitingLabel(data.job);
                startTimer();
            } else {
                setControlsDisabled(false);
                generateLabel.textContent = '开始生成';
            }
        } catch (error) {
            if (error.code === 'STALE_RESPONSE' || disposed) return;
            errors.replaceChildren(notice(errorText(error.code, error.message), 'error'));
            setControlsDisabled(false);
            generateLabel.textContent = '开始生成';
        } finally {
            busy = false;
        }
    }

    promptField.control.addEventListener('input', renderTemplates);
    view.dialog.addEventListener('close', () => { disposed = true; stopTimer(); }, { once: true });

    renderTemplates();
    renderSizes();
    renderResult();
    api('/api/images/options').then(options => {
        if (disposed) return;
        sizes = Array.isArray(options.sizes) ? options.sizes : [];
        renderSizes();
        if (!options.enabled) {
            setControlsDisabled(true);
            errors.replaceChildren(notice(ERROR_TEXT.IMAGE_NOT_CONFIGURED, 'warning'));
        }
    }).catch(error => {
        if (disposed || error.code === 'STALE_RESPONSE') return;
        errors.replaceChildren(notice(errorText(error.code, error.message), 'error'));
    });
    loadHistory();
    return view;
}
