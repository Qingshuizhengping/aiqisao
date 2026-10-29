import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../../lib/database.js';
import { createApplication } from '../../server.js';

export const origin = 'https://internal.test';

export async function fixture(context, options = {}) {
    const db = openDatabase(':memory:');
    const config = { origin, host: '127.0.0.1', port: 0, cookieName: 'test_internal', secureCookies: false,
        sessionTtlMs: 3600000, encryptionKey: Buffer.alloc(32, 7), bootstrapUsername: 'admin',
        bootstrapPassword: 'InitialPassword2026!', chatModel: 'mock-chat', memoryModel: 'mock-memory',
        embeddingModel: 'mock-embed', apiKey: 'mock-key', chatConcurrency: 2, chatQueueCapacity: 32,
        contextCharacters: 48000, memoryContextCharacters: 9000,
        // These long-standing fixtures test the transport/queue contract. Strict
        // answer tests opt in explicitly and use confirmed-source fixtures.
        strictGrounding: false, ...options.config };
    const calls = [];
    const extraction = [];
    const provider = { async *chat(messages, args) { calls.push(messages); yield '**测试**\n\n正常回答。'; },
        async embed(texts) { return texts.map(() => [1, 0, 0, 0]); },
        async extractMemory(input) { extraction.push(input); return { memories: [] }; }, ...options.provider };
    const application = createApplication({ config, database: db, provider });
    const server = application.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    context.after(async () => {
        await application.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        db.close();
    });
    if (options.start !== false) await application.startServices();
    const port = server.address().port;
    function employee(name, role = 'member') {
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`).run(id, name, name, 'unused-test-password', role, now, now);
        const token = randomBytes(32).toString('base64url');
        const csrf = randomBytes(24).toString('base64url');
        db.prepare('INSERT INTO sessions(id,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
            .run(createHash('sha256').update(token).digest('hex'), id, csrf, now, now + 3600000);
        const headers = { Cookie: config.cookieName + '=' + token, Origin: origin, 'X-CSRF-Token': csrf };
        const client = {
            id, headers,
            call(method, route, data, extraHeaders = {}) {
                return new Promise((resolve, reject) => {
                    const body = data === undefined ? undefined : JSON.stringify(data);
                    const request = http.request({ hostname: '127.0.0.1', port, path: route, method,
                        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...extraHeaders } }, response => {
                        let text = '';
                        response.setEncoding('utf8');
                        response.on('data', chunk => { text += chunk; });
                        response.on('end', () => {
                            let parsed;
                            try { parsed = JSON.parse(text); } catch { parsed = text; }
                            resolve({ status: response.statusCode, body: parsed, headers: response.headers });
                        });
                    });
                    request.on('error', reject);
                    request.end(body);
                });
            },
            stream(route, onChunk) {
                return new Promise((resolve, reject) => {
                    const request = http.get({ hostname: '127.0.0.1', port, path: route, headers }, response => {
                        response.setEncoding('utf8');
                        const ended = new Promise(done => { response.once('end', done); response.once('close', done); });
                        response.on('data', chunk => onChunk(chunk, request));
                        resolve({ request, response, ended });
                    });
                    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
                });
            },
        };
        return client;
    }
    async function conversation(client, projectId = null, extra = {}) {
        const result = await client.call('POST', '/api/conversations', { projectId, ...extra });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body.conversation;
    }
    return { ...application, config, provider, calls, extraction, employee, conversation, port };
}

export async function eventually(predicate, timeout = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const result = await predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('condition did not become true');
}

export function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

export async function waitOrAbort(promise, signal) {
    signal.throwIfAborted();
    let abort;
    const aborted = new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', abort); }
}
