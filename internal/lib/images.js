/**
 * @file Image generation service: HTTP surface (requirement R2-01/02/04/08/09).
 *
 * Composition: `image-store` (SQLite) + `image-policy` (in-memory limits) +
 * `image-upstream` (Hunyuan call) + `image-runner` (worker pool).
 *
 * Two rules that must not be broken:
 *  1. A member only ever sees their own jobs — every query filters on `user_id`, and a job
 *     that belongs to someone else answers 404 (never 403, to avoid enumeration).
 *  2. Generated images are served through this router only. The handler sets its own
 *     `Cache-Control` *after* the global `/api/` `no-store` middleware, because Express
 *     applies the last header written.
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, fail } from './errors.js';
import { DEFAULT_SIZE, SIZE_KEYS, SIZE_OPTIONS, sizeKeyOf } from './image-sizes.js';
import { createImageStore } from './image-store.js';
import { createImagePolicy } from './image-policy.js';
import { createImageRunner } from './image-runner.js';
import { createImageUpstream, IMAGE_MESSAGES, ImageFailure, promptHash } from './image-upstream.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_PAGE = 12;
const MAX_PAGE = 50;
const IMAGE_KEYS = ['prompt', 'size', 'requestId'];

/**
 * Builds the download name: `素材-3比4-20261031-1530.png`.
 * The prompt is deliberately absent (R2-09: file names must not leak content).
 *
 * @param {Object} row Job row.
 * @returns {string} Human readable file name.
 */
export function downloadName(row) {
    const extension = String(row.file_name || '').split('.').pop() || 'png';
    const stamp = new Date(Number(row.created_at) || Date.now());
    const pad = value => String(value).padStart(2, '0');
    const date = '' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate());
    const clock = pad(stamp.getHours()) + pad(stamp.getMinutes());
    return '素材-' + String(row.size_key || DEFAULT_SIZE).replace(':', '比') + '-' + date + '-' + clock + '.' + extension;
}

/**
 * Creates the image service.
 *
 * @param {{db: import('better-sqlite3').Database, config?: Object, fetchImpl?: typeof fetch}} options Options.
 * @returns {{router: import('express').Router, start: () => Object, stop: () => Promise<void>, health: () => Object, store: Object, runner: Object, policy: Object, upstream: Object}}
 */
export function createImageService({ db, config = {}, fetchImpl } = {}) {
    const store = createImageStore({ db });
    const policy = createImagePolicy({ config });
    const upstream = createImageUpstream({ config, fetchImpl });
    const runner = createImageRunner({ config, store, upstream });
    const imageDirectory = path.resolve(config.imageDirectory || 'var/images');
    const enabled = Boolean(config.imageApiKey);
    const router = express.Router();

    /**
     * @param {Object} row Job row.
     * @returns {Object} Public job view.
     */
    function jobView(row) {
        const succeeded = row.state === 'succeeded';
        const startedAt = row.started_at || row.created_at;
        const finishedAt = row.finished_at || row.updated_at || startedAt;
        return {
            id: row.id,
            state: row.state,
            sizeKey: row.size_key,
            prompt: row.prompt,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            elapsedMs: Math.max(0, Number(finishedAt) - Number(startedAt)),
            image: succeeded ? {
                url: '/api/images/jobs/' + row.id + '/content?v=' + row.updated_at,
                width: row.width, height: row.height, bytes: row.byte_size,
                mime: row.mime_type, fileName: downloadName(row),
            } : null,
            error: row.state === 'failed' ? { code: row.error_code, message: row.error_message } : null,
        };
    }

    /** @param {Object} request Express request. @returns {Object} The authenticated member. */
    function actor(request) {
        if (!request.user?.id) fail(401, 'AUTH_REQUIRED', '请重新登录。');
        return request.user;
    }

    router.get('/images/options', (request, response) => {
        actor(request);
        response.json({ enabled, model: config.imageModel || 'hy-image-v3.5-preview',
            sizes: SIZE_OPTIONS.map(option => ({ ...option })),
            limits: { prompt: config.imagePromptCharacters || 4000, minute: config.imageMinuteLimit || 5,
                hour: config.imageHourLimit || 30, queue: config.imageQueueCapacity || 8,
                concurrency: config.imageConcurrency || 2 } });
    });

    router.post('/images/jobs', (request, response, next) => {
        try {
            const user = actor(request);
            const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
            if (Object.keys(body).some(key => !IMAGE_KEYS.includes(key))
                || typeof body.prompt !== 'string' || !body.prompt.trim()
                || body.prompt.length > (config.imagePromptCharacters || 4000)
                || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
                || (body.size !== undefined && typeof body.size !== 'string')) {
                fail(400, 'INVALID_IMAGE_INPUT', '请填写 4000 字以内的描述，并选择支持的尺寸。');
            }
            const prompt = body.prompt.trim();
            const sizeKey = sizeKeyOf(body.size);
            if (!enabled) fail(503, 'IMAGE_NOT_CONFIGURED', IMAGE_MESSAGES.IMAGE_NOT_CONFIGURED);

            const requestId = body.requestId.toLowerCase();
            const inputHash = promptHash(prompt, sizeKey);
            const existing = store.findByRequest(user.id, requestId);
            if (existing) {
                // Same key + different content is a client bug, not a new job.
                if (existing.input_hash !== inputHash) fail(409, 'IMAGE_REQUEST_ID_CONFLICT', '相同请求标识的内容不一致。');
                return response.status(200).json({ job: jobView(existing), reused: true });
            }

            try {
                policy.reserve(user.id);
            } catch (error) {
                if (error.retryAfterSeconds) response.set('Retry-After', String(error.retryAfterSeconds));
                if (error instanceof AppError) return next(error);
                throw error;
            }
            policy.checkQueue(store.queuedCount());

            const row = store.insert({ userId: user.id, requestId, inputHash, prompt, sizeKey });
            response.status(202).json({ job: jobView(row) });
            runner.schedule();
        } catch (error) { next(error); }
    });

    router.get('/images/jobs', (request, response, next) => {
        try {
            const user = actor(request);
            const rawLimit = request.query.limit === undefined ? String(HISTORY_PAGE) : String(request.query.limit);
            const limit = Number(rawLimit);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) fail(400, 'INVALID_PAGINATION', '分页参数无效。');
            let before;
            if (request.query.before !== undefined) {
                before = Number(String(request.query.before));
                if (!Number.isInteger(before) || before < 0) fail(400, 'INVALID_PAGINATION', '分页参数无效。');
            }
            const page = store.listOwned(user.id, { limit, before });
            response.json({ jobs: page.rows.map(jobView), hasMore: page.hasMore });
        } catch (error) { next(error); }
    });

    router.get('/images/jobs/:id', (request, response, next) => {
        try {
            const user = actor(request);
            const row = store.findOwned(request.params.id, user.id);
            if (!row) fail(404, 'IMAGE_JOB_NOT_FOUND', '素材不存在。');
            response.json({ job: jobView(row) });
        } catch (error) { next(error); }
    });

    router.get('/images/jobs/:id/content', async (request, response, next) => {
        try {
            const user = actor(request);
            const row = store.findOwned(request.params.id, user.id);
            if (!row) fail(404, 'IMAGE_JOB_NOT_FOUND', '素材不存在。');
            if (row.state !== 'succeeded') fail(409, 'IMAGE_NOT_READY', '图片还没有生成完成。');
            const target = path.resolve(imageDirectory, row.file_name || '');
            if (!target.startsWith(imageDirectory + path.sep)) fail(404, 'IMAGE_JOB_NOT_FOUND', '素材不存在。');
            let bytes;
            try { bytes = await fsp.readFile(target); } catch { fail(410, 'IMAGE_FILE_MISSING', '图片文件已不存在，请重新生成。'); }
            // Overrides the global `/api/` no-store header set earlier in the middleware chain.
            response.set({ 'Content-Type': row.mime_type || 'application/octet-stream',
                'Content-Length': String(bytes.length),
                'Cache-Control': 'private, max-age=31536000, immutable',
                'ETag': '"' + row.id + '-' + row.updated_at + '"',
                'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(downloadName(row)) });
            response.send(bytes);
        } catch (error) { next(error); }
    });

    return {
        router,
        store,
        runner,
        policy,
        upstream,
        /** @returns {{interrupted: number, cancelled: number}} Repair counts. */
        start() { return runner.start(); },
        stop: () => runner.stop(),
        health: () => ({ enabled, model: config.imageModel || 'hy-image-v3.5-preview',
            ...runner.health(), ...store.counts(), limits: policy.snapshot() }),
        /** @returns {string[]} Accepted size keys (used by tests and the frontend contract). */
        sizes: () => [...SIZE_KEYS],
    };
}

export { ImageFailure };
