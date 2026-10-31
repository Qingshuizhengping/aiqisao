/**
 * @file Image job executor (requirement R2-07).
 *
 * A tiny worker pool over SQLite: `claimNext()` moves a `queued` row to `running`
 * atomically, so two workers can never pick the same job and a crash cannot leave a job
 * "claimed but forgotten" (the next start repairs it).
 */

import { ImageFailure, IMAGE_MESSAGES } from './image-upstream.js';

/**
 * Creates the image runner.
 *
 * @param {{config?: Object, store: Object, upstream: Object, now?: () => number}} options Options.
 * @returns {{start: () => Object, stop: () => Promise<void>, schedule: () => void, health: () => Object, runOnce: () => Promise<void>}}
 */
export function createImageRunner({ config = {}, store, upstream }) {
    const concurrency = Math.max(1, Number(config.imageConcurrency) || 2);
    /** @type {Map<string, AbortController>} */
    const active = new Map();
    const workers = new Set();
    let started = false;
    let closed = false;
    let wakeScheduled = false;

    async function runOne(job) {
        const controller = new AbortController();
        active.set(job.id, controller);
        try {
            const result = await upstream.generate({ id: job.id, prompt: job.prompt, sizeKey: job.size_key, signal: controller.signal });
            store.markSucceeded(job.id, result);
        } catch (error) {
            const failure = error instanceof ImageFailure
                ? error
                : new ImageFailure('IMAGE_UPSTREAM_ERROR', IMAGE_MESSAGES.IMAGE_UPSTREAM_ERROR, { cause: error });
            // A shutdown mid-flight is not an upstream problem: report it as interrupted so
            // the member knows the image may still have been produced.
            const code = closed ? 'IMAGE_JOB_INTERRUPTED' : failure.code;
            const message = closed ? IMAGE_MESSAGES.IMAGE_JOB_INTERRUPTED : failure.message;
            try { store.markFailed(job.id, { code, message }); } catch { /* storage is closing */ }
        } finally {
            active.delete(job.id);
            schedule();
        }
    }

    function schedule() {
        if (!started || closed || wakeScheduled) return;
        wakeScheduled = true;
        queueMicrotask(() => {
            wakeScheduled = false;
            while (!closed && active.size < concurrency) {
                const job = store.claimNext();
                if (!job) return;
                const promise = runOne(job);
                workers.add(promise);
                promise.finally(() => workers.delete(promise));
            }
        });
    }

    return {
        /**
         * Repairs leftovers from a previous process and starts draining the queue.
         *
         * @returns {{interrupted: number, cancelled: number}} Repair counts.
         */
        start() {
            if (started) return { interrupted: 0, cancelled: 0 };
            const repaired = store.repairAfterRestart({
                interrupted: IMAGE_MESSAGES.IMAGE_JOB_INTERRUPTED,
                cancelled: IMAGE_MESSAGES.IMAGE_JOB_CANCELLED,
            });
            started = true;
            schedule();
            return repaired;
        },
        async stop() {
            closed = true;
            for (const controller of active.values()) controller.abort(new Error('image service stopping'));
            await Promise.allSettled([...workers]);
        },
        schedule,
        /** @returns {{active: number, started: boolean, concurrency: number}} Runner health. */
        health: () => ({ active: active.size, started, concurrency }),
    };
}
