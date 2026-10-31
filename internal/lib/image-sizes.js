/**
 * @file Image size presets (requirement R2-01).
 *
 * The server is the single source of truth: the browser may only send a preset key, never
 * a raw `WxH` string, so an unsupported (expensive) resolution can never reach the upstream.
 */

import { AppError } from './errors.js';

/** Ratio -> upstream `size` value. Kept under 2K on purpose (no 4K this release). */
export const SIZE_PRESETS = Object.freeze({
    '1:1': '2048x2048',
    '3:4': '1536x2048',
    '4:3': '2048x1536',
    '9:16': '1152x2048',
    '16:9': '2048x1152',
});

/** `auto` is a key without a size: the model picks the composition. */
export const AUTO_SIZE = 'auto';
export const DEFAULT_SIZE = '1:1';

/** Every key the API accepts, in display order. A seventh key is a 400. */
export const SIZE_KEYS = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9', AUTO_SIZE]);

/** Area ceiling: 2048x2048. */
export const MAX_AREA = 2048 * 2048;

/** Options served to the frontend (`GET /api/images/options`). */
export const SIZE_OPTIONS = Object.freeze([
    { key: '1:1', label: '方图', size: SIZE_PRESETS['1:1'], note: '商品主图、平铺' },
    { key: '3:4', label: '竖版', size: SIZE_PRESETS['3:4'], note: '海报、详情页' },
    { key: '4:3', label: '横版', size: SIZE_PRESETS['4:3'], note: '门店场景、横幅' },
    { key: '9:16', label: '竖屏', size: SIZE_PRESETS['9:16'], note: '手机全屏、短视频封面' },
    { key: '16:9', label: '横屏', size: SIZE_PRESETS['16:9'], note: '公众号头图、投屏' },
    { key: AUTO_SIZE, label: '自动', size: null, note: '由模型决定构图' },
]);

/**
 * Resolves a preset key to the upstream `size` value.
 *
 * @param {unknown} value Raw key from the request body (may be undefined).
 * @returns {string|null} Upstream size, or null for `auto` (size omitted).
 * @throws {AppError} 400 `INVALID_IMAGE_INPUT` when the key is unknown or too large.
 */
export function resolveSize(value) {
    const key = value === undefined || value === null || value === '' ? DEFAULT_SIZE : String(value).trim();
    if (key === AUTO_SIZE) return null;
    if (!Object.prototype.hasOwnProperty.call(SIZE_PRESETS, key)) {
        throw new AppError(400, 'INVALID_IMAGE_INPUT', '尺寸选项无效。');
    }
    const size = SIZE_PRESETS[key];
    const matched = /^(\d+)x(\d+)$/.exec(size);
    if (!matched) throw new Error('Image size preset is malformed: ' + key);
    if (Number(matched[1]) * Number(matched[2]) > MAX_AREA) {
        throw new AppError(400, 'INVALID_IMAGE_INPUT', '当前最多支持 2048×2048 的出图尺寸。');
    }
    return size;
}

/**
 * Normalizes the requested size key.
 *
 * @param {unknown} value Raw key.
 * @returns {string} A key from {@link SIZE_KEYS}.
 */
export function sizeKeyOf(value) {
    const key = value === undefined || value === null || value === '' ? DEFAULT_SIZE : String(value).trim();
    if (!SIZE_KEYS.includes(key)) throw new AppError(400, 'INVALID_IMAGE_INPUT', '尺寸选项无效。');
    return key;
}
