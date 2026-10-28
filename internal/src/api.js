export class ApiError extends Error {
    constructor(message, code, status = 0) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

let session = null;
let generation = 0;
let unauthorized = () => {};
let setupRequired = () => {};

export function setSession(value) {
    if (session?.user?.id !== value?.user?.id || session?.csrfToken !== value?.csrfToken) generation++;
    session = value;
}

export function getSession() { return session; }
export function onUnauthorized(callback) { unauthorized = callback; }
export function onSetupRequired(callback) { setupRequired = callback; }

async function request(path, { method = 'GET', body, signal, binary = false, download = false } = {}) {
    const started = generation;
    const headers = { Accept: download ? 'application/octet-stream' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
    if (!['GET', 'HEAD'].includes(method) && session?.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
    let response;
    try {
        response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
            body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal });
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ApiError('连接暂时中断，请检查网络后重试。', 'NETWORK_ERROR');
    }
    if (started !== generation) throw new ApiError('账号或页面状态已更新。', 'STALE_RESPONSE');
    if (download && response.ok) {
        const file = await response.blob();
        if (started !== generation) throw new ApiError('账号或页面状态已更新。', 'STALE_RESPONSE');
        return file;
    }
    let data;
    try { data = await response.json(); } catch { throw new ApiError('服务返回了无法读取的响应。', 'INVALID_RESPONSE', response.status); }
    if (started !== generation) throw new ApiError('账号或页面状态已更新。', 'STALE_RESPONSE');
    if (!response.ok) {
        const failure = new ApiError(data?.error?.message || '请求暂时未完成。', data?.error?.code || 'REQUEST_FAILED', response.status);
        if (response.status === 401 && session && path !== '/api/auth/login') unauthorized(failure);
        if (['PASSWORD_CHANGE_REQUIRED', 'MFA_SETUP_REQUIRED'].includes(failure.code)) setupRequired(failure);
        throw failure;
    }
    return data;
}

export function api(path, options = {}) { return request(path, options); }
export function uploadFile(path, file, { signal } = {}) { return request(path, { method: 'POST', body: file, binary: true, signal }); }
export function downloadFile(path, { signal } = {}) { return request(path, { signal, download: true }); }

export async function subscribeRun(id, onEvent, { signal } = {}) {
    const started = generation;
    const response = await fetch('/api/chat/runs/' + encodeURIComponent(id) + '/events', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal,
    });
    if (!response.ok || !response.body) {
        let data;
        try { data = await response.json(); } catch {}
        const error = new ApiError(data?.error?.message || '实时连接暂时不可用，正在同步保存的结果。', data?.error?.code || 'STREAM_UNAVAILABLE', response.status);
        if (response.status === 401 && session) unauthorized(error);
        throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            if (started !== generation) throw new ApiError('账号已切换。', 'STALE_RESPONSE');
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                const frame = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);
                let event = 'message';
                const lines = [];
                for (const line of frame.split(/\r?\n/)) {
                    if (line.startsWith('event:')) event = line.slice(6).trim();
                    if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
                }
                if (!lines.length) continue;
                let data;
                try { data = JSON.parse(lines.join('\n')); } catch { throw new ApiError('实时内容同步失败，正在读取保存结果。', 'STREAM_INVALID'); }
                if (started !== generation) throw new ApiError('账号已切换。', 'STALE_RESPONSE');
                onEvent(event, data);
                if (event === 'done' || event === 'error') return;
            }
            if (buffer.length > 2 * 1024 * 1024) throw new ApiError('实时内容过长，正在读取保存结果。', 'STREAM_TOO_LARGE');
            if (done) return;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

export function query(parameters) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null && value !== '') search.set(key, value);
    const text = search.toString();
    return text ? '?' + text : '';
}
