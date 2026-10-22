const TERMINAL = new Set(['succeeded', 'needs_clarification', 'failed', 'interrupted']);
const STATES = new Set(['queued', 'optimizing', 'generating', ...TERMINAL]);

function makeIdentifier(cryptoImpl) {
    if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}

export function createStudioJobController({ store, getSnapshot = () => null, fetchImpl = globalThis.fetch,
    cryptoImpl = globalThis.crypto, documentTarget = globalThis.document, windowTarget = globalThis.window,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const entries = new Map();
    const listeners = new Set();
    const operations = new Map();
    const unconsumedOutcomes = new Map();
    let activeId = null;
    let outcome = null;
    let outcomeSequence = 0;
    let timer = null;
    let started = false;
    let disposed = false;

    function getState() {
        const entry = entries.get(activeId);
        return {
            record: entry ? { ...entry.record } : null,
            business: entry?.job?.state || (entry ? 'unconfirmed' : 'idle'),
            network: entry?.network || 'idle',
            issue: entry?.issue || null,
            job: entry?.job || null,
            outcome,
            pending: Array.from(entries.values(), item => ({ ...item.record }))
        };
    }

    function publish() {
        if (!disposed) for (const listener of listeners) listener(getState());
    }

    function subscribe(listener) {
        listeners.add(listener);
        listener(getState());
        return () => listeners.delete(listener);
    }

    function clearPoll() {
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    function canUpload(entry) {
        return !!entry && !entry.record.accepted && !!getSnapshot(entry.record.id) && now() - entry.record.createdAt < 600000;
    }

    function schedulePoll() {
        clearPoll();
        const entry = entries.get(activeId);
        if (disposed || !entry || documentTarget?.hidden || entry.issue?.code === 'UPLOAD_REQUIRED') return;
        timer = setTimer(() => poll(), 2000);
    }

    async function request(method, record, payload) {
        const response = await fetchImpl(method === 'POST' ? '/api/image/jobs' : '/api/image/jobs/' + encodeURIComponent(record.id), {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + record.token },
            body: payload ? JSON.stringify(payload) : undefined,
            cache: 'no-store',
            signal: AbortSignal.timeout(method === 'POST' ? 60000 : 10000)
        });
        let data;
        try { data = await response.json(); } catch {}
        if (!response.ok || data?.status !== 'ok' || !data.job) {
            throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : '后台任务暂时无法连接，请稍后恢复查询。'), { httpStatus: response.status });
        }
        return data.job;
    }

    function finish(entry, job, uncertain = false) {
        if (disposed) return;
        entry.completion = { job, uncertain };
        entry.network = 'idle';
        if (activeId !== entry.record.id) {
            publish();
            return;
        }
        activeId = null;
        clearPoll();
        outcome = { sequence: ++outcomeSequence, record: { ...entry.record }, job, uncertain };
        unconsumedOutcomes.set(outcome.sequence, entry.record);
        publish();
    }

    function acknowledge(sequence) {
        const record = unconsumedOutcomes.get(sequence);
        if (!record || disposed) return false;
        try { store.remove(record); } catch { return false; }
        entries.delete(record.id);
        for (const [pendingSequence, pendingRecord] of unconsumedOutcomes) {
            if (pendingRecord.id === record.id) unconsumedOutcomes.delete(pendingSequence);
        }
        if (activeId === record.id) {
            activeId = null;
            clearPoll();
        }
        publish();
        return true;
    }

    function apply(entry, job) {
        if (disposed) return;
        const record = entry.record;
        if (job.id !== record.id || !STATES.has(job.state) || job.originalPrompt !== record.prompt || job.size !== record.size || job.referenceCount !== record.referenceCount) {
            throw new Error('后台任务信息与本次需求不一致，已停止同步，请保留此页稍后重试。');
        }
        if (job.state === 'succeeded' && (!job.result || typeof job.result.url !== 'string' || !job.result.url)) {
            throw new Error('后台结果暂未确认，正在继续同步，请勿重复提交。');
        }
        record.accepted = true;
        try { store.accept(record); } catch {}
        entry.job = job;
        entry.issue = null;
        entry.network = 'idle';
        if (TERMINAL.has(job.state) && activeId === record.id) {
            finish(entry, job, job.state === 'interrupted' || job.state === 'failed' && job.code === 'IMAGE_GENERATION_UNKNOWN');
        } else publish();
    }

    async function poll() {
        clearPoll();
        const entry = entries.get(activeId);
        if (disposed || !entry || operations.has(entry.record.id) || documentTarget?.hidden) return;
        const operation = {};
        operations.set(entry.record.id, operation);
        entry.network = 'checking';
        publish();
        try {
            apply(entry, await request('GET', entry.record));
        } catch (error) {
            entry.network = 'idle';
            if (error.httpStatus === 404) {
                if (canUpload(entry)) {
                    entry.issue = { code: 'UPLOAD_REQUIRED', message: '尚未确认上传完成，服务器暂未找到任务。可继续上传同一个任务，不会主动新建重复任务。' };
                    publish();
                } else {
                    finish(entry, { state: 'expired', error: '后台任务已过期或无法找回，不会自动重新生成。请先检查最近生成；需要重新提交时请重新上传参考图。' }, true);
                }
            } else {
                entry.network = 'offline';
                entry.issue = { code: 'CONNECTION_LOST', message: error.message };
                publish();
            }
        } finally {
            if (operations.get(entry.record.id) === operation) operations.delete(entry.record.id);
            schedulePoll();
        }
    }

    async function upload(id = activeId) {
        const entry = entries.get(id);
        if (disposed || !entry || operations.has(id)) return;
        if (!canUpload(entry)) {
            if (id === activeId) await poll();
            return;
        }
        clearPoll();
        const snapshot = getSnapshot(id);
        const operation = {};
        operations.set(id, operation);
        entry.network = 'uploading';
        entry.issue = null;
        publish();
        const payload = { requestId: id, prompt: snapshot.prompt, size: snapshot.size, optimize: snapshot.optimizationEnabled };
        if (snapshot.referenceImages.length) payload.referenceImages = snapshot.referenceImages.slice();
        try {
            apply(entry, await request('POST', entry.record, payload));
        } catch (error) {
            entry.network = 'idle';
            if (error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408) {
                finish(entry, { state: 'rejected', error: error.message || '任务未能提交，请重新检查输入。' }, error.httpStatus === 409);
            } else {
                entry.issue = { code: 'UPLOAD_UNCONFIRMED', message: '正在确认后台任务是否已接收，请勿重复提交…' };
                publish();
            }
        } finally {
            if (operations.get(id) === operation) operations.delete(id);
            if (activeId === id && entries.has(id)) await poll();
            else schedulePoll();
        }
    }

    function create(snapshot) {
        if (disposed) throw new Error('后台任务控制器已关闭，请刷新后重试。');
        const tokenBytes = cryptoImpl.getRandomValues(new Uint8Array(32));
        const record = { id: makeIdentifier(cryptoImpl), token: Array.from(tokenBytes, byte => byte.toString(16).padStart(2, '0')).join(''),
            createdAt: now(), accepted: false, prompt: snapshot.prompt, size: snapshot.size,
            referenceCount: snapshot.referenceImages.length, optimizationEnabled: snapshot.optimizationEnabled };
        try { store.create(record); } catch {
            throw new Error('浏览器无法保存后台任务凭据，尚未提交生成。请允许本站本地存储后重试。');
        }
        entries.set(record.id, { record, job: null, network: 'idle', issue: null });
        activeId = record.id;
        outcome = null;
        return { ...record };
    }

    function syncStore() {
        let records;
        try { records = store.list(); } catch { return; }
        for (const record of records) {
            const existing = entries.get(record.id);
            if (!existing) entries.set(record.id, { record, job: null, network: 'idle', issue: null });
            else if (existing.record.token === record.token && record.accepted) {
                existing.record.accepted = true;
                if (existing.issue?.code === 'UPLOAD_REQUIRED') existing.issue = null;
            }
        }
        publish();
    }

    function activate(id) {
        const entry = entries.get(id);
        if (!entry || disposed) return false;
        clearPoll();
        activeId = id;
        outcome = null;
        publish();
        if (entry.completion) finish(entry, entry.completion.job, entry.completion.uncertain);
        else if (entry.job && TERMINAL.has(entry.job.state)) apply(entry, entry.job);
        else if (entry.issue?.code !== 'UPLOAD_REQUIRED') poll();
        return true;
    }

    function wake() {
        if (disposed || documentTarget?.hidden) return;
        syncStore();
        const entry = entries.get(activeId);
        if (!entry && entries.size && !outcome) activate(entries.keys().next().value);
        else if (entry && entry.issue?.code !== 'UPLOAD_REQUIRED') poll();
    }

    function storageChanged(event) {
        if (!store.matchesKey(event.key)) return;
        syncStore();
        wake();
    }

    function visibilityChanged() {
        if (documentTarget?.hidden) clearPoll();
        else wake();
    }

    function start() {
        if (started || disposed) return;
        started = true;
        documentTarget?.addEventListener('visibilitychange', visibilityChanged);
        windowTarget?.addEventListener('pageshow', wake);
        windowTarget?.addEventListener('online', wake);
        windowTarget?.addEventListener('pagehide', clearPoll);
        windowTarget?.addEventListener('storage', storageChanged);
        syncStore();
        if (entries.size) activate(entries.keys().next().value);
    }

    function dispose() {
        disposed = true;
        clearPoll();
        listeners.clear();
        documentTarget?.removeEventListener('visibilitychange', visibilityChanged);
        windowTarget?.removeEventListener('pageshow', wake);
        windowTarget?.removeEventListener('online', wake);
        windowTarget?.removeEventListener('pagehide', clearPoll);
        windowTarget?.removeEventListener('storage', storageChanged);
    }

    return { start, dispose, subscribe, getState, create, upload, activate, poll, acknowledge,
        retry: () => entries.get(activeId)?.issue?.code === 'UPLOAD_REQUIRED' ? upload() : poll() };
}
