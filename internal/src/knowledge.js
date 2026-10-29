import { api, query, uploadFile, downloadFile, getSession } from './api.js';
import { el, button, input, panel, notice, empty, badge, formatDate, confirmAction, toast } from './ui.js';
import { openGroundingSource } from './grounding.js';

const scopes = { personal: '个人资料', project_private: '项目内个人资料', project_shared: '项目共享资料' };
const states = { queued: '等待解析', running: '正在解析', processing: '正在解析', ready: '解析就绪', failed: '解析未完成', interrupted: '解析已中断' };
const pendingStates = new Set(['queued', 'running', 'processing']);
const allowedExtensions = ['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'xlsx'];
const defaultMaxBytes = 10 * 1024 * 1024;

function filename(file) { return file.name || file.filename || '未命名资料'; }
function fileState(file) { return file.state || file.processingState; }
function sizeLabel(value) {
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
}
function ignored(error) { return error.name === 'AbortError' || error.code === 'STALE_RESPONSE'; }
function statusBadges(file) {
    const state = fileState(file);
    return [file.status === 'candidate' && badge('待管理员确认', 'warning'), file.status === 'rejected' && badge('未通过'),
        badge(state === 'ready' && file.status !== 'active' ? '解析就绪' : states[state] || '处理中', ['failed', 'interrupted'].includes(state) ? 'warning' : state === 'ready' && file.status === 'active' ? 'accent' : ''),
        state === 'ready' && file.status === 'active' && ['queued', 'running'].includes(file.indexState) && badge('语义索引处理中'),
        state === 'ready' && file.status === 'active' && file.indexState === 'failed' && badge('关键词检索可用', 'warning')].filter(Boolean);
}

async function saveDownload(file, { signal } = {}) {
    const blob = await downloadFile('/api/knowledge/files/' + encodeURIComponent(file.id) + '/download', { signal });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename(file).replace(/[\\/\u0000-\u001f]/g, '_') });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createKnowledgeLibrary({ user, project, scope: initialScope = 'personal', onFile, onReopen }) {
    let scope = initialScope;
    let active = false;
    let disposed = false;
    let loading = false;
    let uploading = false;
    let revision = 0;
    let timer;
    let readController;
    let uploadController;
    let files = [];
    let limits = { maxBytes: defaultMaxBytes, maxFiles: 40, extensions: allowedExtensions };
    const results = el('div', { className: 'stack-tight knowledge-files' });
    const errors = el('div');
    const progress = el('div', { className: 'knowledge-upload-progress', role: 'status', 'aria-live': 'polite', hidden: true });
    const search = input('查找资料文件', { type: 'search', placeholder: '搜索文件名或资料内容', maxlength: 200 });
    const fileInput = el('input', { type: 'file', multiple: true, accept: allowedExtensions.map(value => '.' + value).join(','), hidden: true, 'aria-label': '选择上传的资料文件' });
    const upload = button('上传资料', () => fileInput.click(), { glyph: 'plus', className: 'button primary' });
    const refresh = button('刷新', () => load(), { className: 'button small' });
    const description = el('p', { className: 'muted knowledge-help', text: '支持 PDF、Word（.docx）、Excel（.xlsx）、TXT、Markdown（.md）、CSV 和 JSON，每个文件不超过 10 MB。解析后请核对来源版本及重要事实，确认后用于严格资料回答；图片与扫描件暂不识别。' });
    const help = el('div');
    const searchForm = el('form', { className: 'search-row' }, search.wrapper, button('', null, { type: 'submit', glyph: 'search', name: '搜索资料文件', className: 'icon-button' }));
    const element = el('section', { className: 'stack knowledge-library', 'aria-label': '资料文件' },
        el('div', { className: 'row-between knowledge-heading' }, el('div', {}, el('h3', { text: '让资料成为讨论的背景' }), el('p', { className: 'muted', text: '上传、解析、检索，回答时可查看资料来源。' })), upload),
        fileInput, el('details', { className: 'knowledge-format-help' }, el('summary', { text: '支持格式与限制 · 单个文件 10 MB' }), description), help, searchForm, progress, errors, results, el('div', { className: 'actions' }, refresh));

    function connected() { return !disposed && active && element.isConnected; }
    function updateUpload() {
        const archived = scope !== 'personal' && Boolean(project?.archived);
        upload.disabled = uploading || archived;
        upload.textContent = uploading ? '正在上传…' : '上传资料';
        fileInput.disabled = uploading || archived;
        help.replaceChildren(...(archived ? [notice('项目已归档，资料文件仅供查看。')] : scope === 'project_shared'
            ? [notice(project?.role === 'admin' ? '共享审核决定项目可见范围。重要事实还需在“事实与确认”中核对来源版本。' : '共享资料先等待项目管理员审核，再核对作为正式依据的来源版本。')]
            : [notice(scope === 'personal' ? '个人资料用于你的跨会话讨论，系统管理员可只读审计。' : '仅用于你在当前项目的讨论，不跨项目使用；系统管理员可只读审计。')]));
    }
    function schedulePoll() {
        clearTimeout(timer);
        if (connected() && !document.hidden && files.some(file => pendingStates.has(fileState(file)) || file.status === 'active' && ['queued', 'running'].includes(file.indexState))) timer = setTimeout(() => load(true), 2200);
    }
    async function load(quiet = false) {
        if (!connected()) return;
        readController?.abort();
        readController = new AbortController();
        const current = ++revision;
        loading = true;
        refresh.disabled = true;
        if (!quiet) { results.replaceChildren(empty('正在读取资料…')); errors.replaceChildren(); }
        try {
            const data = await api('/api/knowledge/files' + query({ scope, projectId: scope === 'personal' ? undefined : project?.id, q: search.control.value.trim() }), { signal: readController.signal });
            if (!connected() || current !== revision) return;
            files = Array.isArray(data.files) ? data.files : [];
            limits = { ...limits, ...data.limits };
            results.replaceChildren(...(files.length ? files.map(renderFile) : [empty('这里还没有资料文件', '上传产品资料、项目文档或工作规范，AI七嫂·员工专属版会结合相关片段回答。')]));
        } catch (error) {
            if (connected() && current === revision && !ignored(error)) errors.replaceChildren(notice(error.message, 'error'));
        } finally {
            if (current === revision) { loading = false; refresh.disabled = false; schedulePoll(); }
        }
    }
    async function action(callback) {
        errors.replaceChildren();
        try { await callback(); if (connected()) await load(true); }
        catch (error) { if (connected() && !ignored(error)) errors.replaceChildren(notice(error.message, 'error')); }
    }
    function renderFile(file) {
        const actions = el('div', { className: 'card-actions' }, button('查看内容', () => onFile(file.id), { glyph: 'folder' }));
        if (fileState(file) === 'ready' && file.status === 'active') actions.append(button('核对事实依据', () => openGroundingSource({
            reference: { sourceType: 'file', sourceId: file.id, version: file.version }, onBack: onReopen,
        }), { glyph: 'shield' }));
        if (file.canDownload) actions.append(button('下载原文件', () => action(() => saveDownload(file)), { className: 'button' }));
        if (file.canRetry) actions.append(button(file.indexState === 'failed' && fileState(file) === 'ready' ? '重建语义索引' : '重试处理', () => action(() => api('/api/knowledge/files/' + encodeURIComponent(file.id) + '/retry', { method: 'POST', body: {} }))));
        if (file.canReview) actions.append(button('确认共享', () => action(() => api('/api/knowledge/files/' + encodeURIComponent(file.id) + '/review', { method: 'POST', body: { decision: 'approve' } })), { glyph: 'check', disabled: fileState(file) !== 'ready', title: fileState(file) === 'ready' ? '确认共享' : '解析完成后可确认共享' }),
            button('不予采用', () => action(() => api('/api/knowledge/files/' + encodeURIComponent(file.id) + '/review', { method: 'POST', body: { decision: 'reject' } }))));
        if (file.canDelete) actions.append(button('删除', async () => {
            const approved = await confirmAction('删除这份资料？', '删除后，原文件与解析内容将退出后续检索；已有聊天记录保留。', '删除资料');
            try { if (approved) { await api('/api/knowledge/files/' + encodeURIComponent(file.id), { method: 'DELETE' }); toast('资料已删除，不再用于后续回答。'); } }
            catch (error) { if (!ignored(error)) toast(error.message, 'error'); }
            if (getSession()?.user?.id === user?.id) onReopen();
        }, { className: 'button danger', glyph: 'trash' }));
        return el('article', { className: 'card knowledge-file', 'data-file-id': file.id },
            el('div', { className: 'knowledge-file-title' }, el('span', { className: 'knowledge-file-type', text: (filename(file).split('.').pop() || 'FILE').toUpperCase().slice(0, 8) }), el('h3', { text: filename(file) })),
            el('div', { className: 'knowledge-file-status' }, ...statusBadges(file)),
            el('div', { className: 'card-meta' }, el('span', { text: sizeLabel(file.size ?? file.sizeBytes ?? 0) }), el('span', { text: formatDate(file.createdAt) }), file.ownerName && el('span', { text: file.ownerName }), file.chunkCount > 0 && el('span', { text: file.chunkCount + ' 个资料片段' })),
            file.errorMessage && notice(file.errorMessage, 'warning'),
            fileState(file) === 'ready' && file.status === 'active' && file.indexState === 'failed' && notice('语义索引暂未完成，仍可通过关键词查找资料。可以重建索引恢复语义检索。', 'warning'), actions);
    }
    async function addFiles(selected) {
        if (uploading || !selected.length || !connected()) return;
        const batch = Array.from(selected);
        const allowed = new Set(limits.extensions.map(extension => String(extension).replace(/^\./, '').toLowerCase()));
        const oversized = batch.find(file => file.size > limits.maxBytes);
        const unsupported = batch.find(file => !allowed.has(file.name.split('.').pop().toLowerCase()));
        if (batch.length > 10) { errors.replaceChildren(notice('每次最多选择 10 个文件，请分批上传。', 'error')); return; }
        if (oversized) { errors.replaceChildren(notice('「' + oversized.name + '」超过单个文件 10 MB 的限制。', 'error')); return; }
        if (unsupported) { errors.replaceChildren(notice('「' + unsupported.name + '」的文件格式暂不支持。', 'error')); return; }
        uploadController = new AbortController();
        const uploadScope = scope;
        uploading = true; updateUpload(); errors.replaceChildren(); progress.hidden = false;
        let completed = 0;
        const failures = [];
        try {
            for (const file of batch) {
                progress.textContent = '正在上传 ' + (completed + failures.length + 1) + '/' + batch.length + '：' + file.name;
                try {
                    await uploadFile('/api/knowledge/files' + query({ scope: uploadScope, projectId: uploadScope === 'personal' ? undefined : project?.id, name: file.name }), file, { signal: uploadController.signal });
                    completed++;
                } catch (error) {
                    if (ignored(error)) throw error;
                    failures.push(file.name + '：' + error.message);
                }
                if (!connected() || uploadScope !== scope) break;
            }
            if (connected()) {
                progress.textContent = completed ? '已上传 ' + completed + ' 份资料。解析完成后请到“事实与确认”核对来源及重要事实。' : '上传未完成。';
                await load(true);
                if (failures.length) errors.replaceChildren(...failures.map(message => notice(message, 'error')));
            }
        } catch (error) { if (connected() && !ignored(error)) errors.replaceChildren(notice(error.message, 'error')); }
        finally { uploading = false; fileInput.value = ''; if (!disposed) updateUpload(); }
    }
    function wake() { if (document.hidden) clearTimeout(timer); else if (connected() && !loading) load(true); }
    fileInput.addEventListener('change', () => addFiles(fileInput.files));
    searchForm.addEventListener('submit', event => { event.preventDefault(); load(); });
    document.addEventListener('visibilitychange', wake);
    updateUpload();
    return { element, refresh: load,
        setScope(value) { if (scope === value) return; scope = value; revision++; readController?.abort(); uploadController?.abort(); files = []; search.control.value = ''; progress.hidden = true; updateUpload(); },
        setActive(value) { active = value; element.hidden = !value; if (value) load(); else { clearTimeout(timer); revision++; readController?.abort(); } },
        dispose() { disposed = true; clearTimeout(timer); readController?.abort(); uploadController?.abort(); document.removeEventListener('visibilitychange', wake); },
    };
}

export function openKnowledgeFile({ fileId, onBack } = {}) {
    const content = el('div', { className: 'stack' }, empty('正在读取资料…'));
    const view = panel('资料内容', content, { wide: true, subtitle: '文字预览用于核对解析结果；原文件中的图片与版式不会在此显示。' });
    const controller = new AbortController();
    view.dialog.addEventListener('close', () => controller.abort(), { once: true });
    async function load() {
        try {
            const data = await api('/api/knowledge/files/' + encodeURIComponent(fileId), { signal: controller.signal });
            if (!view.dialog.isConnected) return;
            const file = data.file;
            const actions = el('div', { className: 'actions' });
            if (onBack) actions.append(button('返回资料文件', onBack, { glyph: 'back' }));
            if (file.canDownload) actions.append(button('下载原文件', async () => {
                try { await saveDownload(file, { signal: controller.signal }); }
                catch (error) { if (!ignored(error)) toast(error.message, 'error'); }
            }));
            const text = typeof data.text === 'string' ? data.text : '';
            content.replaceChildren(...[el('h3', { className: 'knowledge-preview-title', text: filename(file) }),
                el('div', { className: 'knowledge-file-status' }, ...statusBadges(file)),
                el('div', { className: 'card-meta' }, el('span', { text: scopes[file.scope] || '资料文件' }), el('span', { text: sizeLabel(file.size ?? file.sizeBytes ?? 0) }), el('span', { text: formatDate(file.updatedAt || file.createdAt) })),
                file.errorMessage && notice(file.errorMessage, 'warning'),
                text ? el('pre', { className: 'knowledge-preview', text, tabindex: 0, 'aria-label': '解析文字预览' }) : notice(pendingStates.has(fileState(file)) ? '文件已保存，正在准备文字内容。可返回资料列表查看进度。' : '暂无可预览的文字内容。'),
                text && file.characterCount > text.length && notice('当前展示前 ' + text.length.toLocaleString() + ' 个字符；检索会使用已解析的完整文字。'), actions].filter(child => child !== false && child !== undefined && child !== null));
        } catch (error) {
            if (view.dialog.isConnected && !ignored(error)) content.replaceChildren(notice(error.message, 'error'), onBack ? button('返回资料文件', onBack) : button('重新读取', load));
        }
    }
    load();
    return view;
}
