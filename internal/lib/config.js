import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));

function boundedNumber(value, fallback, minimum, maximum) {
    if (value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error('Invalid numeric application setting');
    return number;
}

// Enum settings keep a single authoritative source: the environment variable is the
// only input, and anything outside the allowed list fails at startup (no silent
// fallback), so a typo can never silently flip the answer mode.
function enumValue(value, allowed, fallback, message) {
    const normalized = value === undefined || value === '' ? fallback : String(value).trim();
    if (!allowed.includes(normalized)) throw new Error(message);
    return normalized;
}

// Search providers are addressed by a short slug so a typo cannot point the adapter at an
// arbitrary host. An empty string legitimately means "search disabled".
function optionalProvider(value) {
    const normalized = value === undefined ? '' : String(value).trim();
    if (!normalized) return '';
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(normalized)) throw new Error('INTERNAL_SEARCH_PROVIDER must be a lowercase provider slug');
    return normalized;
}

// Optional base URL must be a bare HTTPS origin: no credentials, query or fragment, so the
// adapter cannot be redirected somewhere surprising.
function optionalHttpsUrl(value) {
    const normalized = value === undefined ? '' : String(value).trim();
    if (!normalized) return '';
    let url;
    try { url = new URL(normalized); } catch { throw new Error('INTERNAL_SEARCH_BASE_URL must be a trusted HTTPS origin'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('INTERNAL_SEARCH_BASE_URL must be a trusted HTTPS origin');
    }
    return normalized.replace(/\/+$/, '');
}

// Model names are restricted to a conservative slug so a typo cannot inject anything into
// the upstream request body.
function boundedModel(value, fallback) {
    if (value === undefined || value === '') return fallback;
    const model = String(value).trim();
    if (!/^[a-z0-9][a-z0-9.\-]{2,63}$/i.test(model)) throw new Error('INTERNAL_IMAGE_MODEL must be a model slug');
    return model;
}

export function createConfig(env = process.env) {
    const origin = new URL(env.INTERNAL_ORIGIN || 'http://127.0.0.1:3001');
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('INTERNAL_ORIGIN must contain only an origin');
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local && env.NODE_ENV !== 'production')) throw new Error('HTTPS is required outside local development');
    const encoded = env.INTERNAL_ENCRYPTION_KEY || '';
    const encryptionKey = Buffer.from(encoded, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== encoded) throw new Error('INTERNAL_ENCRYPTION_KEY must be a 32-byte base64 key');
    const apiBase = String(env.INTERNAL_API_BASE || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    const apiUrl = new URL(apiBase);
    if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) throw new Error('Model API requires a trusted HTTPS base');
    const chatModel = env.INTERNAL_CHAT_MODEL || 'zai-org/GLM-5.3-Flash';
    const searchProvider = optionalProvider(env.INTERNAL_SEARCH_PROVIDER);
    const searchApiKey = env.INTERNAL_SEARCH_API_KEY || '';
    const dataDirectory = path.resolve(APP_DIRECTORY, env.INTERNAL_DATA_DIRECTORY || 'var');
    // Generated images live under the data directory and never inside dist/: they must
    // survive a rebuild and stay outside anything the static handler serves.
    const imageDirectory = path.resolve(dataDirectory, env.INTERNAL_IMAGE_DIRECTORY || 'images');
    if (!imageDirectory.startsWith(dataDirectory + path.sep)) throw new Error('INTERNAL_IMAGE_DIRECTORY must stay inside the data directory');
    return {
        origin: origin.origin,
        host: env.INTERNAL_HOST || '127.0.0.1',
        port: boundedNumber(env.INTERNAL_PORT, 3001, 1, 65535),
        secureCookies: origin.protocol === 'https:',
        cookieName: origin.protocol === 'https:' ? '__Host-wzy_internal' : 'wzy_internal_dev',
        sessionTtlMs: 12 * 3600000,
        encryptionKey,
        bootstrapUsername: env.INTERNAL_BOOTSTRAP_USERNAME || 'admin',
        bootstrapPassword: env.INTERNAL_BOOTSTRAP_PASSWORD || '',
        chatModel,
        memoryModel: env.INTERNAL_MEMORY_MODEL || chatModel,
        embeddingModel: env.INTERNAL_EMBEDDING_MODEL || 'BAAI/bge-m3',
        apiBase,
        apiKey: env.INTERNAL_API_KEY || '',
        // H3: the one and only switch for the answer pipeline. 'free' is the default
        // (open answer, streaming provider) and 'strict' rolls back to the four-stage
        // evidence gate. It replaces the deleted legacy boolean flag (see T02 notes).
        groundingMode: enumValue(env.INTERNAL_GROUNDING_MODE, ['free', 'strict'], 'free',
            'INTERNAL_GROUNDING_MODE must be strict or free'),
        // Storage breaker cooldown. Exposed only so tests can shrink the wait to ~80ms;
        // production keeps three seconds.
        chatBreakerCooldownMs: boundedNumber(env.INTERNAL_CHAT_BREAKER_COOLDOWN_MS, 3000, 50, 600000),
        // R1-05: web search adapter. Empty provider/key means "no search at all" — the
        // adapter then answers 'disabled' without touching the network.
        searchProvider,
        searchApiKey,
        searchBaseUrl: optionalHttpsUrl(env.INTERNAL_SEARCH_BASE_URL),
        searchTimeoutMs: boundedNumber(env.INTERNAL_SEARCH_TIMEOUT_MS, 8000, 1000, 30000),
        searchMaxResults: boundedNumber(env.INTERNAL_SEARCH_MAX_RESULTS, 5, 1, 10),
        // Read-only derivation: never a second environment override.
        searchEnabled: Boolean(searchProvider && searchApiKey),
        dataDirectory,
        // ---- R2 image generation -------------------------------------------------
        imageApiBase: optionalHttpsUrl(env.INTERNAL_IMAGE_API_BASE)
            || 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',
        imageApiKey: env.INTERNAL_IMAGE_API_KEY || '',
        imageModel: boundedModel(env.INTERNAL_IMAGE_MODEL, 'hy-image-v3.5-preview'),
        imageTimeoutMs: boundedNumber(env.INTERNAL_IMAGE_TIMEOUT_MS, 150000, 5000, 180000),
        imageConcurrency: boundedNumber(env.INTERNAL_IMAGE_CONCURRENCY, 2, 1, 4),
        imageQueueCapacity: boundedNumber(env.INTERNAL_IMAGE_QUEUE_CAPACITY, 8, 0, 64),
        imageMinuteLimit: boundedNumber(env.INTERNAL_IMAGE_MINUTE_LIMIT, 5, 1, 60),
        imageHourLimit: boundedNumber(env.INTERNAL_IMAGE_HOUR_LIMIT, 30, 1, 500),
        // Fixed product limits (PRD hard requirements, not tunable at runtime).
        imagePromptCharacters: 4000,
        imageMaxBytes: 20971520,
        imageDirectory,
        chatConcurrency: boundedNumber(env.INTERNAL_CHAT_CONCURRENCY, 4, 1, 8),
        chatQueueCapacity: 32,
        contextCharacters: 48000,
        memoryContextCharacters: 9000,
        providerTimeoutMs: boundedNumber(env.INTERNAL_PROVIDER_TIMEOUT_MS, 180000, 1000, 900000),
        embeddingTimeoutMs: boundedNumber(env.INTERNAL_EMBEDDING_TIMEOUT_MS, 5000, 1000, 30000),
    };
}
