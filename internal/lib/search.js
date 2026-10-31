/**
 * @file Web search adapter (requirement R1-05/06/07).
 *
 * The adapter is deliberately conservative: it is the only place in the product that
 * could ever reach the public internet, so it must be silent by default.
 *
 *   - No `INTERNAL_SEARCH_PROVIDER` / `INTERNAL_SEARCH_API_KEY`  -> `disabled`, zero fetch.
 *   - Member turned the preference off                            -> `disabled`, zero fetch.
 *   - Provider not implemented (e.g. `tavily`, this release)      -> `degraded`, zero fetch.
 *   - Provider failed or timed out                                -> `degraded`, answer still works.
 *
 * `stub` is a test-only provider: it never resolves a real hostname, and when a
 * `fetchImpl` is injected it delegates to it so tests can simulate latency and failures.
 */

/** @typedef {{ title: string, url: string, snippet: string }} SearchResult */

/** @typedef {{ status: 'ok'|'disabled'|'degraded', results: SearchResult[], reason?: string }} SearchOutcome */

const PROVIDER_NAME = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_TITLE = 200;
const MAX_SNIPPET = 200;

/** Fixed payload for the test-only provider (never used in production). */
const STUB_RESULTS = Object.freeze([
    { title: '薇之雨门店运营手册（示例）', url: 'https://example.com/materials/store-playbook',
        snippet: '门店每周排班需覆盖早晚高峰，并留出培训时段。' },
    { title: '调肤服务接待流程（示例）', url: 'https://example.com/materials/skin-consult-flow',
        snippet: '先做皮肤评估，再给出护理建议与跟进计划。' },
]);

function truncate(value, limit) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function httpsUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    try {
        const url = new URL(text);
        // Only https is allowed: the answer quotes these links, and http would downgrade
        // the page the member is asked to open.
        if (url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        return url.href;
    } catch { return null; }
}

/**
 * Cleans raw provider output: drops non-https or malformed entries, truncates long text
 * and caps the list length.
 *
 * @param {unknown} results Raw provider results.
 * @param {number} maxResults Upper bound for the returned list.
 * @returns {SearchResult[]} Sanitized results.
 */
export function sanitizeResults(results, maxResults = 5) {
    const limit = Math.max(1, Number(maxResults) || 5);
    if (!Array.isArray(results)) return [];
    const cleaned = [];
    for (const entry of results) {
        if (!entry || typeof entry !== 'object') continue;
        const url = httpsUrl(entry.url);
        if (!url) continue;
        const title = truncate(entry.title || url, MAX_TITLE);
        if (!title) continue;
        cleaned.push({ title, url, snippet: truncate(entry.snippet ?? entry.description ?? entry.content ?? '', MAX_SNIPPET) });
        if (cleaned.length >= limit) break;
    }
    return cleaned;
}

/**
 * Creates the search adapter.
 *
 * @param {Object} options Options.
 * @param {Object} options.config Application config (search* fields).
 * @param {typeof fetch} [options.fetchImpl] Transport override (tests inject this).
 * @param {() => number} [options.now] Clock, kept injectable for deterministic tests.
 * @returns {{enabled: boolean, retrieve: (query: string, options?: {signal?: AbortSignal, user?: {searchEnabled?: boolean}}) => Promise<SearchOutcome>, health: () => {enabled: boolean, provider: string}}}
 */
export function createSearch({ config = {}, fetchImpl, now = Date.now } = {}) {
    // R1: `searchEnabled` is derived, never a second env override.
    const enabled = Boolean(config.searchProvider && config.searchApiKey);
    const providerName = String(config.searchProvider || '');
    const injected = typeof fetchImpl === 'function';
    const transport = injected ? fetchImpl : fetch;
    const timeoutMs = Number(config.searchTimeoutMs) || 8000;
    const maxResults = Number(config.searchMaxResults) || 5;

    /**
     * Test-only provider. Without an injected transport it answers from a fixed payload,
     * so no test ever depends on a real network call.
     *
     * @param {{query: string, signal?: AbortSignal}} input Search input.
     * @returns {Promise<unknown>} Raw results.
     */
    async function stub(input) {
        if (!injected) return STUB_RESULTS;
        const response = await transport('https://search.test/stub', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: input.query }), signal: input.signal });
        if (!response || typeof response.json !== 'function') return STUB_RESULTS;
        const payload = await response.json();
        // A stub that ignores its input and answers `{results: [...]}` is enough for tests;
        // an empty body keeps the fixed payload so the happy path is still exercised.
        return payload && Array.isArray(payload.results) ? payload.results : STUB_RESULTS;
    }

    /**
     * Skeleton for a real provider. Deliberately unimplemented in this release: it must
     * throw so the caller degrades instead of leaking queries to a third party.
     *
     * @returns {Promise<never>} Always throws.
     */
    async function tavily() {
        const error = new Error('search provider is not implemented yet');
        error.code = 'SEARCH_PROVIDER_UNSUPPORTED';
        throw error;
    }

    const providers = new Map([['stub', stub], ['tavily', tavily]]);

    return {
        enabled,
        health: () => ({ enabled, provider: enabled ? providerName : '' }),
        /**
         * @param {string} query Member question.
         * @param {{signal?: AbortSignal, user?: {searchEnabled?: boolean}}} [options] Options.
         * @returns {Promise<SearchOutcome>} Search outcome; never throws.
         */
        async retrieve(query, { signal, user } = {}) {
            // Three cheap guards that guarantee zero outbound requests.
            if (!enabled) return { status: 'disabled', results: [], reason: 'not_configured' };
            if (user && user.searchEnabled === false) return { status: 'disabled', results: [], reason: 'user_disabled' };
            const text = truncate(query, 2000);
            if (!text) return { status: 'disabled', results: [], reason: 'empty_query' };
            if (!PROVIDER_NAME.test(providerName) || !providers.has(providerName)) {
                return { status: 'degraded', results: [], reason: 'unsupported_provider' };
            }

            const timeout = AbortSignal.timeout(timeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            try {
                const raw = await providers.get(providerName)({ query: text, signal: combined, maxResults });
                const results = sanitizeResults(raw, maxResults);
                return { status: 'ok', results, at: now() };
            } catch (error) {
                // Any failure degrades silently: the answer keeps working, without sources.
                return { status: 'degraded', results: [], reason: error?.code || error?.name || 'search_failed' };
            }
        },
    };
}
