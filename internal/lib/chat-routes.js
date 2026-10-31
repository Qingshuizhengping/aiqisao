import express from 'express';
import { audit, requireReadyEmployee } from './access.js';
import { CHAT_TERMINAL as TERMINAL } from './chat-service.js';

export function createChatRouter({ db, domain, runner }) {
    const router = express.Router();
    const { loadConversation, visibleMessage } = domain;
    const { snapshot, stopRun } = runner;
    router.get('/conversations', (request, response) => response.json(domain.listConversations(request.user, request.query.projectId || null)));
    router.post('/conversations', (request, response) => response.status(201).json(domain.createConversation(request.user, request.body || {})));
    router.get('/conversations/:id', (request, response) => response.json(domain.readConversation(request.user, request.params.id)));
    router.patch('/conversations/:id', (request, response) => response.json(domain.updateConversation(request.user, request.params.id, request.body || {})));
    router.delete('/conversations/:id', (request, response) => response.json(domain.deleteConversation(request.user, request.params.id, runner.stopRun)));
    router.post('/chat/runs', (request, response) => {
        const state = runner.health();
        if (!state.ready) {
            // H1: tell the client when to come back instead of returning a bare 503, so the
            // frontend can say “约 N 秒后自动恢复” while the breaker cools down.
            const wait = Math.max(1, Math.ceil(((state.breaker?.openUntil || Date.now() + 3000) - Date.now()) / 1000));
            response.set('Retry-After', String(wait));
            return response.status(503).json({ error: { code: 'CHAT_NOT_READY', message: '聊天服务正在恢复，请稍后重试。' },
                retryAfterSeconds: wait });
        }
        const result = domain.submitRun(request.user, request.body || {});
        response.status(result.reused ? 200 : 202).json({ run: result.run });
        if (!result.reused) runner.schedule();
    });

    router.get('/chat/runs/:id', (request, response) => {
        const result = snapshot(request.params.id, request.user);
        const ownerId = db.prepare('SELECT user_id FROM chat_runs WHERE id=?').get(request.params.id).user_id;
        if (ownerId !== request.user.id) audit(db, request.user, 'project.chat_run.read', 'chat_run', request.params.id);
        response.json(result);
    });
    router.post('/chat/runs/:id/stop', (request, response) => response.json(stopRun(request.params.id, request.user)));
    router.get('/chat/runs/:id/events', (request, response) => {
        const initial = snapshot(request.params.id, request.user);
        const id = request.params.id;
        const ownerId = db.prepare('SELECT user_id FROM chat_runs WHERE id=?').get(id).user_id;
        if (ownerId !== request.user.id) audit(db, request.user, 'project.chat_run.subscribe', 'chat_run', id);
        const actorId = request.user.id;
        const sessionId = request.session.id;
        response.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        function valid() {
            const session = db.prepare('SELECT user_id,expires_at FROM sessions WHERE id=?').get(sessionId);
            if (!session || session.expires_at <= Date.now() || session.user_id !== actorId) return false;
            try {
                const { user } = requireReadyEmployee(db, { id: actorId });
                loadConversation(initial.run.conversationId, user);
                return true;
            } catch { return false; }
        }
        function write(event, data) {
            if (response.destroyed) return;
            if (!valid()) { response.end(); return; }
            if (response.writableLength > 256 * 1024) { response.end(); return; }
            if (data.message) {
                const ownerId = db.prepare('SELECT user_id FROM chat_runs WHERE id=?').get(id)?.user_id;
                data = { ...data, message: visibleMessage(data.message, request.user, ownerId) };
            }
            response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
            if (event === 'done' || event === 'error') response.end();
        }
        const unsubscribe = runner.subscribe(id, write);
        write('snapshot', initial);
        if (TERMINAL.has(initial.run.state)) write('done', initial);
        const heartbeat = setInterval(() => {
            if (!valid()) response.end();
            else if (!response.destroyed) response.write(': heartbeat\n\n');
        }, 5000);
        heartbeat.unref?.();
        response.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    return router;
}
