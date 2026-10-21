import './_env.js';

export const IMAGE_API_URL = process.env.HUNYUAN_IMAGE_API_URL
    || 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation';
export const IMAGE_MODEL = process.env.HUNYUAN_IMAGE_MODEL || 'hy-image-v3.5-preview';
export const IMAGE_TIMEOUT = 150000;

export function getImageApiKey() {
    return process.env.HUNYUAN_API_KEY || process.env.TOKENHUB_API_KEY || '';
}
