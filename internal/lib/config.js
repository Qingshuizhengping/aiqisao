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
        // evidence gate. Replaces the deleted `strictGrounding` flag.
        groundingMode: enumValue(env.INTERNAL_GROUNDING_MODE, ['free', 'strict'], 'free',
            'INTERNAL_GROUNDING_MODE must be strict or free'),
        // Storage breaker cooldown. Exposed only so tests can shrink the wait to ~80ms;
        // production keeps three seconds.
        chatBreakerCooldownMs: boundedNumber(env.INTERNAL_CHAT_BREAKER_COOLDOWN_MS, 3000, 50, 600000),
        dataDirectory: path.resolve(APP_DIRECTORY, env.INTERNAL_DATA_DIRECTORY || 'var'),
        chatConcurrency: boundedNumber(env.INTERNAL_CHAT_CONCURRENCY, 4, 1, 8),
        chatQueueCapacity: 32,
        contextCharacters: 48000,
        memoryContextCharacters: 9000,
        providerTimeoutMs: boundedNumber(env.INTERNAL_PROVIDER_TIMEOUT_MS, 180000, 1000, 900000),
        embeddingTimeoutMs: boundedNumber(env.INTERNAL_EMBEDDING_TIMEOUT_MS, 5000, 1000, 30000),
    };
}
