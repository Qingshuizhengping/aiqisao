/**
 * @file Per-member rate limiting and queue admission for image generation (R2-03).
 *
 * Everything is in memory on purpose: the PRD explicitly allows the counters to reset on
 * restart, and keeping them out of SQLite avoids a write on every rejected request.
 */

import { AppError } from './errors.js';

/** User facing text for the local rate limit (also used by the frontend mapping). */
export const RATE_LIMIT_MESSAGE = '生成太频繁了，请稍后再试（每分钟 5 次、每小时 30 次）';
export const QUEUE_FULL_MESSAGE = '生成任务较多，请稍后再试';

const MINUTE = 60000;
const HOUR = 3600000;

/**
 * Creates the image policy.
 *
 * @param {{config?: Object, now?: () => number}} [options] Options.
 * @returns {{reserve: (userId: string) => void, checkQueue: (pending: number) => void, health: () => Object, snapshot: () => Object}}
 */
export function createImagePolicy({ config = {}, now = Date.now } = {}) {
    const minuteLimit = Number(config.imageMinuteLimit) || 5;
    const hourLimit = Number(config.imageHourLimit) || 30;
    const concurrency = Number(config.imageConcurrency) || 2;
    const queueCapacity = Number(config.imageQueueCapacity) || 8;
    /** @type {Map<string, number[]>} userId -> accepted timestamps (hour window). */
    const accepted = new Map();

    function prune(userId) {
        const cutoff = now() - HOUR;
        const entries = (accepted.get(userId) || []).filter(timestamp => timestamp > cutoff);
        if (entries.length) accepted.set(userId, entries);
        else accepted.delete(userId);
        return entries;
    }

    /** Seconds until the oldest minute-window entry falls out (>= 1). */
    function retryAfterSeconds(entries) {
        const cutoff = now() - MINUTE;
        const inWindow = entries.filter(timestamp => timestamp > cutoff);
        if (!inWindow.length) return 1;
        return Math.max(1, Math.ceil((inWindow[0] + MINUTE - now()) / 1000));
    }

    return {
        /**
         * Consumes one slot or throws `IMAGE_RATE_LIMITED` (429 + Retry-After).
         *
         * @param {string} userId Member id.
         * @returns {void}
         */
        reserve(userId) {
            const entries = prune(userId);
            const minuteCount = entries.filter(timestamp => timestamp > now() - MINUTE).length;
            if (minuteCount >= minuteLimit || entries.length >= hourLimit) {
                const wait = retryAfterSeconds(entries);
                const error = new AppError(429, 'IMAGE_RATE_LIMITED', RATE_LIMIT_MESSAGE);
                error.retryAfterSeconds = wait;
                throw error;
            }
            entries.push(now());
            accepted.set(userId, entries);
            // Bound the map so a long running process cannot grow without limit.
            if (accepted.size > 4096 && !accepted.has(userId)) accepted.delete(accepted.keys().next().value);
        },
        /**
         * Rejects when the waiting queue is already full. `imageQueueCapacity` counts
         * *waiting* jobs; the running ones are bounded by `imageConcurrency`.
         *
         * @param {number} pending Number of queued jobs.
         * @returns {void}
         */
        checkQueue(pending) {
            if (pending >= queueCapacity) throw new AppError(503, 'IMAGE_QUEUE_FULL', QUEUE_FULL_MESSAGE);
        },
        snapshot: () => ({ users: accepted.size, minuteLimit, hourLimit, concurrency, queueCapacity }),
        health: () => ({ ready: true, users: accepted.size, minuteLimit, hourLimit, concurrency, queueCapacity }),
    };
}
