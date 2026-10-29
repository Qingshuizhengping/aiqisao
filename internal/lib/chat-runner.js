import { AppError, fail } from './errors.js';
import { CHAT_TERMINAL as TERMINAL } from './chat-service.js';

const ACTIVE = new Set(['queued', 'running']);

export function createChatRunner({ db, config, provider, memory, domain }) {
    const { loadConversation, messageView, visibleMessage, runView, actorForRun, buildContext } = domain;
    const workers = new Map();
    const subscribers = new Map();
    let started = false;
    let closed = false;
    let storageFailure = false;
    let wakeScheduled = false;

    function snapshot(id, user) {
        const row = db.prepare('SELECT * FROM chat_runs WHERE id=?').get(id);
        if (!row) fail(404, 'CHAT_RUN_NOT_FOUND', '生成记录不存在。');
        loadConversation(row.conversation_id, user);
        const message = db.prepare('SELECT * FROM messages WHERE id=?').get(row.assistant_message_id);
        const active = workers.get(id);
        return { run: runView(row), message: visibleMessage(messageView(active ? { ...message, content: active.text } : message), user, row.user_id) };
    }

    function broadcast(id, event, data) {
        for (const subscriber of subscribers.get(id) || []) {
            try { subscriber(event, data); } catch {}
        }
    }

    function persistText(run, worker) {
        if (!worker.dirty) return;
        db.prepare('UPDATE messages SET content=?,updated_at=? WHERE id=?').run(worker.text, Date.now(), run.assistant_message_id);
        worker.dirty = false;
        worker.persistedAt = Date.now();
    }

    function finish(run, worker, state, error) {
        const now = Date.now();
        const changed = db.transaction(() => {
            const current = db.prepare('SELECT state FROM chat_runs WHERE id=?').get(run.id);
            if (!ACTIVE.has(current?.state)) return false;
            db.prepare('UPDATE messages SET content=?,status=?,updated_at=? WHERE id=?')
                .run(worker.text, state === 'completed' ? 'complete' : state, now, run.assistant_message_id);
            db.prepare('UPDATE chat_runs SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, error?.code || null, now, run.id);
            db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, run.conversation_id);
            return true;
        })();
        if (!changed) return;
        const row = db.prepare('SELECT * FROM chat_runs WHERE id=?').get(run.id);
        const data = { run: runView(row), message: messageView(db.prepare('SELECT * FROM messages WHERE id=?').get(run.assistant_message_id)) };
        if (error) data.error = { code: error.code, message: error.message };
        broadcast(run.id, state === 'completed' || state === 'stopped' ? 'done' : 'error', data);
    }

    async function execute(run) {
        const worker = { controller: new AbortController(), text: '', dirty: false, persistedAt: 0, promise: null };
        workers.set(run.id, worker);
        let permissionTimer;
        worker.promise = (async () => {
            try {
                actorForRun(run);
                db.prepare("UPDATE chat_runs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(Date.now(), run.id);
                permissionTimer = setInterval(() => {
                    try { actorForRun(run); } catch { worker.controller.abort(new AppError(403, 'CHAT_ACCESS_REVOKED', '账号或项目权限变化，生成已停止。')); }
                }, 1000);
                permissionTimer.unref?.();
                const messages = await buildContext(run, worker);
                worker.controller.signal.throwIfAborted();
                for await (const delta of provider.chat(messages, { signal: worker.controller.signal })) {
                    worker.controller.signal.throwIfAborted();
                    actorForRun(run);
                    if (typeof delta !== 'string') throw new AppError(502, 'MODEL_RESPONSE_INVALID', '模型返回格式异常。');
                    if (worker.text.length + delta.length > 100000) throw new AppError(502, 'MODEL_OUTPUT_LIMIT', '回复过长，已保留生成内容。');
                    const offset = worker.text.length;
                    worker.text += delta;
                    worker.dirty = true;
                    if (Date.now() - worker.persistedAt >= 200) persistText(run, worker);
                    broadcast(run.id, 'delta', { delta, offset });
                }
                worker.controller.signal.throwIfAborted();
                actorForRun(run);
                if (!worker.text.trim()) throw new AppError(502, 'MODEL_EMPTY_RESPONSE', '模型没有返回有效内容，请稍后重试。');
                finish(run, worker, 'completed');
                try {
                    memory.enqueueTurn({ userId: run.user_id, conversationId: run.conversation_id,
                        userMessageId: run.user_message_id, assistantMessageId: run.assistant_message_id });
                } catch {
                    db.prepare('UPDATE messages SET metadata=? WHERE id=?').run(JSON.stringify({ ...worker.metadata, memoryPendingError: true }), run.assistant_message_id);
                }
            } catch (error) {
                try {
                    const stopped = worker.controller.signal.aborted;
                    const safe = error instanceof AppError ? error : new AppError(502,
                        stopped ? 'CHAT_INTERRUPTED' : error?.name === 'TimeoutError' ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE',
                        stopped ? '生成已停止，收到的内容已保留。' : '模型连接暂时不可用，已保留收到的内容。');
                    finish(run, worker, closed ? 'interrupted' : stopped ? 'stopped' : 'failed', safe);
                } catch {
                    storageFailure = true;
                    broadcast(run.id, 'error', { error: { code: 'CHAT_STORAGE_UNAVAILABLE', message: '聊天存储异常，请稍后重新同步，避免重复提交。' } });
                }
            } finally {
                clearInterval(permissionTimer);
                workers.delete(run.id);
                schedule();
            }
        })();
        await worker.promise;
    }

    function schedule() {
        if (!started || closed || storageFailure || wakeScheduled) return;
        wakeScheduled = true;
        queueMicrotask(() => {
            wakeScheduled = false;
            try {
                const available = (config.chatConcurrency || 4) - workers.size;
                if (available <= 0) return;
                for (const row of db.prepare("SELECT * FROM chat_runs WHERE state='queued' ORDER BY created_at LIMIT ?").all(available)) {
                    if (!workers.has(row.id)) execute(row).catch(() => { storageFailure = true; });
                }
            } catch { storageFailure = true; }
        });
    }

    function stopRun(id, user) {
        const current = snapshot(id, user);
        const run = db.prepare('SELECT * FROM chat_runs WHERE id=?').get(id);
        if (run.user_id !== user.id) fail(403, 'CHAT_RUN_READ_ONLY', '不能停止他人的生成。');
        if (TERMINAL.has(run.state)) return current;
        const worker = workers.get(id) || { text: current.message.content };
        worker.controller?.abort();
        finish(run, worker, 'stopped');
        return snapshot(id, user);
    }

    function start() {
        if (started) return;
        db.transaction(() => {
            const interrupted = db.prepare("SELECT * FROM chat_runs WHERE state='running'").all();
            for (const run of interrupted) {
                db.prepare("UPDATE messages SET status='interrupted',updated_at=? WHERE id=?").run(Date.now(), run.assistant_message_id);
                db.prepare("UPDATE chat_runs SET state='interrupted',error_code='SERVER_RESTARTED',updated_at=? WHERE id=?").run(Date.now(), run.id);
            }
        })();
        started = true;
        schedule();
    }

    async function stop() {
        closed = true;
        for (const worker of workers.values()) worker.controller.abort();
        await Promise.allSettled([...workers.values()].map(worker => worker.promise));
        for (const listeners of subscribers.values()) for (const listener of listeners) listener('error', { error: { code: 'SERVER_STOPPING', message: '服务正在重启，稍后会恢复同步。' } });
    }

    function subscribe(id, listener) {
        const listeners = subscribers.get(id) || new Set();
        listeners.add(listener); subscribers.set(id, listeners);
        return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(id); };
    }

    return { start, stop, snapshot, stopRun, schedule, subscribe, health: () => ({ ready: started && !closed && !storageFailure, active: workers.size }) };
}
