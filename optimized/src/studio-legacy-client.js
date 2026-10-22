export function createStudioLegacyClient({ fetchImpl = (...args) => fetch(...args), crypto = globalThis.crypto,
    newRequestId = () => crypto.randomUUID(), requestTimeout = 240000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    async function postJson(path, payload, timeout) {
        const controller = new AbortController();
        const timer = timeout > 0 ? setTimer(() => controller.abort(), timeout) : null;
        try {
            const response = await fetchImpl(path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), signal: controller.signal,
            });
            let data = null;
            try { data = await response.json(); } catch (error) {
                if (error?.name === 'AbortError') throw error;
            }
            if (!response.ok || !data || typeof data !== 'object') {
                const failure = new Error(data && typeof data.error === 'string' && data.error || '请求失败 HTTP ' + response.status);
                failure.httpStatus = response.status;
                failure.code = data?.code;
                failure.allowOriginal = data?.allowOriginal === true;
                throw failure;
            }
            return data;
        } catch (error) {
            if (error?.httpStatus) throw error;
            const message = error?.name === 'AbortError'
                ? path === '/api/image/prepare' ? '视觉优化等待超时，尚未发起生图。' : '生成等待超时，结果尚未确认。服务可能仍在处理，请勿立即重复提交。'
                : path === '/api/image/prepare' ? '视觉优化连接中断，尚未发起生图。' : '生图连接中断，结果尚未确认。服务可能仍在处理，请勿立即重复提交。';
            const failure = new Error(message);
            failure.transport = true;
            throw failure;
        } finally {
            if (timer !== null) clearTimer(timer);
        }
    }

    function ensureCurrent(isCurrent) {
        if (!isCurrent()) throw new Error('输入已变化，本次准备已取消，请重新生成。');
    }

    async function prepare(snapshot, { isCurrent = () => true } = {}) {
        const hashes = [];
        const encoder = new TextEncoder();
        for (const reference of snapshot.referenceImages) {
            const digest = await crypto.subtle.digest('SHA-256', encoder.encode(reference));
            hashes.push(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''));
        }
        ensureCurrent(isCurrent);
        const requestId = newRequestId();
        let prepared;
        try {
            prepared = await postJson('/api/image/prepare', {
                prompt: snapshot.prompt, size: snapshot.size, referenceHashes: hashes, requestId,
            }, 0);
        } catch (error) {
            error.allowOriginal = Boolean(error.transport || [502, 503, 504].includes(error.httpStatus)
                && error.code === 'OPTIMIZATION_UNAVAILABLE' && error.allowOriginal);
            throw error;
        }
        ensureCurrent(isCurrent);
        if (prepared.status === 'needs_clarification') {
            if (typeof prepared.question !== 'string' || !prepared.question.trim()) throw new Error('视觉优化未返回有效的补充问题，请修改描述后重新提交。');
            return { state: 'needs_clarification', question: prepared.question };
        }
        if (prepared.status !== 'ready' || typeof prepared.optimizationToken !== 'string' || !prepared.optimizationToken
            || prepared.originalPrompt !== snapshot.prompt || typeof prepared.optimizedPrompt !== 'string' || !prepared.optimizedPrompt.trim()) {
            throw new Error('优化结果与本次需求不一致，已停止生图，请重新提交。');
        }
        return { state: 'ready', prepared: { ...prepared, preparationRequestId: requestId } };
    }

    async function generate(snapshot, prepared, { isCurrent = () => true } = {}) {
        ensureCurrent(isCurrent);
        const payload = { prompt: snapshot.prompt, size: snapshot.size,
            requestId: prepared ? prepared.preparationRequestId : newRequestId() };
        if (snapshot.referenceImages.length) payload.referenceImages = snapshot.referenceImages.slice();
        if (prepared) payload.optimizationToken = prepared.optimizationToken;
        try {
            const data = await postJson('/api/image', payload, requestTimeout);
            if (data.status !== 'ok' || typeof data.url !== 'string' || !data.url) {
                const failure = new Error(typeof data.error === 'string' ? data.error : '生成结果未确认，请勿盲目重试；重新生成可能重复计费。');
                failure.uncertain = true;
                throw failure;
            }
            return { state: 'succeeded', result: data };
        } catch (error) {
            error.uncertain = Boolean(error.transport || error.uncertain || error.httpStatus >= 500 || error.httpStatus === 409 || error.httpStatus < 400);
            throw error;
        }
    }

    return { prepare, generate };
}
