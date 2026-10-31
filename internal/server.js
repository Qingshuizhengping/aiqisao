import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { APP_DIRECTORY, createConfig } from './lib/config.js';
import { openDatabase } from './lib/database.js';
import { createAuth } from './lib/auth.js';
import { createProjectsRouter } from './lib/projects.js';
import { createAdminRouter } from './lib/admin.js';
import { createMemoryService } from './lib/memory.js';
import { createKnowledgeService } from './lib/knowledge.js';
import { createChatService } from './lib/chat.js';
import { createSearch } from './lib/search.js';
import { createProvider } from './lib/provider.js';
import { createGroundingLibrary } from './lib/grounding-library.js';
import { createGroundingRetrieval } from './lib/grounding-retrieval.js';
import { createGroundedAnswerService } from './lib/grounding-answer.js';
import { AppError } from './lib/errors.js';

export const VERSION = 'internal-v20261030-3';

export function createApplication({ config, database, provider: suppliedProvider, fetchImpl } = {}) {
    config ||= createConfig();
    const db = database || openDatabase(path.join(config.dataDirectory, 'internal.sqlite'));
    const provider = suppliedProvider || createProvider({ config });
    // R1-05: the search adapter is assembled here so its transport can be injected in tests.
    const search = createSearch({ config, fetchImpl });
    const auth = createAuth({ db, config });
    const memory = createMemoryService({ db, config, provider });
    const knowledge = createKnowledgeService({ db, config, provider });
    const groundingLibrary = createGroundingLibrary({ db, provider });
    const groundingRetrieval = createGroundingRetrieval({ db, config, provider, library: groundingLibrary });
    const grounding = createGroundedAnswerService({ db, provider, library: groundingLibrary, retrieval: groundingRetrieval });
    // H3: exactly one source of truth decides the answer pipeline. We deliberately do
    // not look at whether a provider was injected: that used to silently flip the mode
    // for transport fixtures, which is how a test suite can stay green while running
    // the wrong branch. Invalid values are rejected by createConfig(); hand-built
    // configs fall back to the documented default 'free'.
    const groundingMode = config.groundingMode === undefined || config.groundingMode === null ? 'free' : config.groundingMode;
    if (groundingMode !== 'free' && groundingMode !== 'strict') throw new Error('INTERNAL_GROUNDING_MODE must be strict or free');
    const chat = createChatService({ db, config, provider, memory, knowledge, search, grounding: groundingMode === 'strict' ? grounding : null });
    const app = express();
    let ready = false;
    let started = false;
    let closed = false;
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use((request, response, next) => {
        response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(),microphone=(),geolocation=()',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        if (request.path.startsWith('/api/')) response.set('Cache-Control', 'no-store');
        next();
    });
    app.use(express.json({ limit: '256kb', strict: true }));
    app.get('/api/health', (request, response) => {
        const state = chat.health();
        const healthy = ready && state.ready;
        response.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'recovering',
            version: VERSION, chatReady: healthy,
            // H1: the breaker snapshot is part of the health contract so the control panel
            // can show the last storage error without a restart.
            chat: { ready: state.ready, active: state.active,
                breaker: state.breaker || { state: 'closed', failures: 0, openUntil: null, lastError: null } },
            memory: memory.health(), knowledge: knowledge.health(),
            search: search.health(),
            grounding: { mode: groundingMode, ready }, modelConfigured: Boolean(config.apiKey) });
    });
    app.use('/api', auth.guardOrigin);
    app.use('/api/auth', auth.router);
    app.use('/api', auth.requireReadyUser, (request, response, next) => {
        if (!ready) return next(new AppError(503, 'APP_NOT_READY', '服务正在恢复，请稍后重试。'));
        next();
    });
    app.get('/api/users/directory', (request, response) => {
        response.json({ users: db.prepare('SELECT id,username,display_name AS displayName FROM users WHERE active=1 ORDER BY display_name').all() });
    });
    app.use('/api/projects', createProjectsRouter({ db }));
    app.use('/api/admin', createAdminRouter({ db, auth }));
    app.use('/api', memory.router);
    app.use('/api', knowledge.router);
    app.use('/api', groundingLibrary.router);
    app.use('/api', chat.router);
    app.use('/api', (request, response) => response.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }));
    const publicDirectory = path.join(APP_DIRECTORY, 'dist');
    app.use(express.static(publicDirectory, {
        dotfiles: 'deny', index: false, etag: true,
        setHeaders(response, filename) {
            response.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(filename) ? 'public, max-age=0, must-revalidate' : 'no-cache');
            if (path.basename(filename) === 'sw.js') response.setHeader('Service-Worker-Allowed', '/');
        },
    }));
    app.get(['/', '/login', '/admin'], (request, response) => {
        const index = path.join(publicDirectory, 'index.html');
        if (!fs.existsSync(index)) return response.status(503).type('text/plain').send('请先执行 npm run build。');
        response.set('Cache-Control', 'no-cache').sendFile(index);
    });
    app.use((error, request, response, next) => {
        if (response.headersSent) { response.end(); return; }
        const safe = error instanceof AppError;
        const status = safe ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
        const code = safe ? error.code : status === 413 ? 'REQUEST_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR';
        if (status >= 500) console.error(JSON.stringify({ event: 'internal_api_error', code, status }));
        response.status(status).json({ error: { code, message: safe ? error.message : status === 413 ? '请求内容过大。' : status === 400 ? '请求格式无效。' : '服务暂时不可用，请稍后重试。' } });
    });

    async function startServices() {
        if (started) return;
        await auth.bootstrap();
        await memory.start();
        await knowledge.start();
        chat.start();
        started = true;
        ready = true;
    }

    async function close() {
        if (closed) return;
        closed = true;
        ready = false;
        await chat.stop();
        await knowledge.stop();
        await memory.stop();
        if (!database) db.close();
    }

    return { app, db, auth, memory, knowledge, chat, search, grounding, groundingLibrary, groundingRetrieval, config, startServices, close };
}

export async function startServer(options = {}) {
    const application = createApplication(options);
    const server = application.app.listen(application.config.port, application.config.host);
    try {
        await once(server, 'listening');
        await application.startServices();
    } catch (error) {
        await application.close();
        server.close();
        throw error;
    }
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        await application.close();
        await new Promise(resolve => server.close(resolve));
    };
    return { ...application, server, close };
}

export async function runStandalone() {
    const envFile = path.join(APP_DIRECTORY, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    const running = await startServer();
    console.log(JSON.stringify({ event: 'internal_started', version: VERSION, address: running.config.host, port: running.config.port }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
        try { await running.close(); process.exitCode = 0; } catch { process.exitCode = 1; }
    });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await runStandalone();
