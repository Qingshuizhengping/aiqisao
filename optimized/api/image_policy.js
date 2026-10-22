import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/i;

export function imageOwnerId(owner) {
    if (owner && typeof owner === 'object') {
        if (typeof owner.imageOwnerHash !== 'string' || !HASH.test(owner.imageOwnerHash)) {
            throw new TypeError('Invalid internal image owner');
        }
        return owner.imageOwnerHash.toLowerCase();
    }
    return createHash('sha256').update(String(owner || 'unknown').slice(0, 256)).digest('hex');
}

export function createImagePolicy({ now = () => Date.now(), ownerCapacity = 2048, minuteLimit = 5, hourLimit = 30 } = {}) {
    const imageAdmissions = new Map();
    const optimizationAdmissions = new Map();

    function reserve(records, owner, optimization) {
        const timestamp = now();
        for (const [key, entries] of records) {
            const active = entries.filter(entry => timestamp - entry.time < 3600000);
            if (active.length) records.set(key, active);
            else records.delete(key);
        }
        const key = imageOwnerId(owner);
        if (!records.has(key) && records.size >= ownerCapacity) {
            throw Object.assign(new Error('生成任务较多，请稍后再试。'), { status: 503,
                code: optimization ? 'OPTIMIZATION_BUSY' : 'IMAGE_BUSY' });
        }
        const entries = records.get(key) || [];
        if (entries.length >= hourLimit || entries.filter(entry => timestamp - entry.time < 60000).length >= minuteLimit) {
            throw Object.assign(new Error(optimization ? '需求优化太频繁，请稍后再试。'
                : '生成太频繁了，请稍后再试（每分钟 5 次、每小时 30 次）。'),
            { status: 429, code: optimization ? 'OPTIMIZATION_RATE_LIMITED' : 'IMAGE_RATE_LIMITED' });
        }
        const entry = { time: timestamp };
        entries.push(entry);
        records.set(key, entries);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = records.get(key);
            if (!current) return;
            const remaining = current.filter(candidate => candidate !== entry);
            if (remaining.length) records.set(key, remaining);
            else records.delete(key);
        };
    }

    return {
        reserveImage: owner => reserve(imageAdmissions, owner, false),
        consumeOptimization: owner => { reserve(optimizationAdmissions, owner, true); },
    };
}

export const imagePolicy = createImagePolicy();
