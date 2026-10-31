/**
 * @file Storage failure circuit breaker (requirement H1).
 *
 * A pure state machine with no database or HTTP dependency, so every transition can
 * be unit-tested with an injected clock. The chat runner uses it to stop hammering a
 * broken SQLite file and — crucially — to heal itself once storage comes back, without
 * requiring a process restart.
 *
 * States:
 *   closed    — normal operation, every attempt is allowed.
 *   open      — failures >= threshold; `allow()` is false until `openUntil` passes.
 *   half-open — cooldown expired; a single probe is allowed. Success closes the
 *               breaker, another failure re-opens it with a doubled cooldown.
 *
 * Any successful storage round-trip resets the breaker, so "one transient SQLITE_BUSY,
 * then everything works again" never escalates.
 */

/**
 * @typedef {Object} StorageBreakerError
 * @property {string} code Machine-readable failure code, e.g. 'SQLITE_BUSY'.
 * @property {number} at Timestamp (ms) of the failure.
 */

/**
 * @typedef {Object} StorageBreakerSnapshot
 * @property {'closed'|'open'|'half-open'} state Current state.
 * @property {number} failures Consecutive failure count.
 * @property {number|null} openUntil Timestamp when the open window ends, or null.
 * @property {StorageBreakerError|null} lastError Last recorded failure.
 */

/**
 * Creates a storage breaker.
 *
 * @param {Object} [options] Options.
 * @param {() => number} [options.now] Clock used for all timestamps (default `Date.now`).
 * @param {number} [options.threshold] Consecutive failures that open the breaker.
 * @param {number} [options.cooldownMs] First cooldown window in milliseconds.
 * @param {number} [options.maxCooldownMs] Upper bound for the exponentially grown window.
 * @param {(snapshot: StorageBreakerSnapshot) => void} [options.onOpen] Called once when the
 *     breaker becomes half-open, so the owner can run a real probe.
 * @param {(snapshot: StorageBreakerSnapshot) => void} [options.onClose] Called when a
 *     success returns the breaker to `closed`.
 * @returns {{allow: () => boolean, recordSuccess: () => void, recordFailure: (error?: {code?: string}) => void,
 *     state: () => 'closed'|'open'|'half-open', snapshot: () => StorageBreakerSnapshot, dispose: () => void}}
 */
export function createStorageBreaker({
    now = Date.now,
    threshold = 5,
    cooldownMs = 3000,
    maxCooldownMs = 60000,
    onOpen,
    onClose,
} = {}) {
    const failureThreshold = Math.max(1, threshold);
    const baseCooldown = Math.max(1, cooldownMs);
    const ceiling = Math.max(baseCooldown, maxCooldownMs);

    let current = 'closed';
    let failures = 0;
    let openUntil = null;
    let lastError = null;
    let delay = baseCooldown;
    let openedBefore = false;
    let probeNotified = false;
    let timer = null;

    function snapshot() {
        return {
            state: current,
            failures,
            openUntil,
            lastError: lastError ? { code: lastError.code, at: lastError.at } : null,
        };
    }

    function notify(handler) {
        if (typeof handler !== 'function') return;
        try { handler(snapshot()); } catch { /* a listener must never break the runner */ }
    }

    function clearProbe() {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
    }

    function scheduleProbe(waitMs) {
        clearProbe();
        timer = setTimeout(() => {
            timer = null;
            if (current === 'closed') return;
            enterHalfOpen();
        }, waitMs);
        // Never keep the process (or a test runner) alive just for a probe.
        timer.unref?.();
    }

    function enterHalfOpen() {
        current = 'half-open';
        if (probeNotified) return;
        probeNotified = true;
        notify(onOpen);
    }

    function open() {
        // First open uses the configured cooldown; every reopen doubles it, capped.
        delay = openedBefore ? Math.min(delay * 2, ceiling) : Math.min(baseCooldown, ceiling);
        openedBefore = true;
        probeNotified = false;
        current = 'open';
        openUntil = now() + delay;
        scheduleProbe(delay);
    }

    /** Lazy transition so callers never observe a stale 'open' after the cooldown. */
    function refresh() {
        if (current === 'open' && openUntil !== null && now() >= openUntil) enterHalfOpen();
    }

    return {
        allow() {
            refresh();
            return current !== 'open';
        },
        recordSuccess() {
            const wasOpen = current !== 'closed';
            clearProbe();
            current = 'closed';
            failures = 0;
            openUntil = null;
            delay = baseCooldown;
            openedBefore = false;
            probeNotified = false;
            if (wasOpen) notify(onClose);
        },
        recordFailure(error) {
            refresh();
            const previous = current;
            failures += 1;
            lastError = { code: (error && (error.code || error.message)) || 'STORAGE_UNAVAILABLE', at: now() };
            if (previous === 'closed' && failures < failureThreshold) return;
            open();
        },
        state() {
            refresh();
            return current;
        },
        snapshot,
        dispose() {
            clearProbe();
        },
    };
}
