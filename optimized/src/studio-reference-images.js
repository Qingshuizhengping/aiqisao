export const MAX_REFERENCES = 20;
export const MAX_REFERENCE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_CHARS = 14000000;

export function createReferenceCollection({ maxCount = MAX_REFERENCES, maxChars = MAX_REFERENCE_CHARS } = {}) {
    let entries = [];
    let revision = 0;
    let pending = null;

    function validate(items) {
        if (items.length > maxCount) throw new Error('最多添加 ' + maxCount + ' 张参考图，请先移除一些图片');
        let total = 0;
        for (const item of items) {
            if (!item || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl)) throw new Error('参考图格式不支持');
            total += item.dataUrl.length;
        }
        if (total > maxChars) throw new Error('参考图总大小过大，请减少图片或换成更小的图片');
    }

    function replace(items) {
        validate(items);
        entries = items.map(item => ({ dataUrl: item.dataUrl, name: item.name || '' }));
        revision++;
        pending = null;
    }

    async function append(items, prepare) {
        if (pending || !items.length) return { ok: false };
        const batch = { revision };
        pending = batch;
        const current = () => pending === batch && revision === batch.revision;
        try {
            if (entries.length + items.length > maxCount) throw new Error('最多添加 ' + maxCount + ' 张参考图，请先移除一些图片');
            const prepared = entries.slice();
            for (const item of items) {
                const reference = await prepare(item);
                if (!current()) return { ok: false, stale: true };
                prepared.push(reference);
                validate(prepared);
            }
            replace(prepared);
            return { ok: true };
        } catch (error) {
            return current() ? { ok: false, error } : { ok: false, stale: true };
        } finally {
            if (pending === batch) pending = null;
        }
    }

    return {
        get count() { return entries.length; },
        get reading() { return pending !== null; },
        list: () => entries.map(item => ({ ...item })),
        replace,
        append,
        remove(index) {
            if (!Number.isInteger(index) || index < 0 || index >= entries.length) return false;
            replace(entries.filter((item, position) => position !== index));
            return true;
        },
    };
}

export function createReferenceProcessor({ document = globalThis.document, ImageType = globalThis.Image,
    ReaderType = globalThis.FileReader, fetchImpl = (...args) => fetch(...args) } = {}) {
    function read(file) {
        return new Promise((resolve, reject) => {
            const reader = new ReaderType();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(file);
        });
    }

    function shrink(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new ImageType();
            image.onload = () => {
                const width = image.naturalWidth || 0;
                const height = image.naturalHeight || 0;
                if (!width || !height) return reject(new Error('参考图尺寸无效，请换一张图片'));
                const scale = Math.min(1, 1600 / Math.max(width, height));
                if (scale >= 1 && dataUrl.length < 1200000 && /^data:image\/(?:png|jpe?g);base64,/i.test(dataUrl)) return resolve(dataUrl);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(width * scale);
                    canvas.height = Math.round(height * scale);
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('无法处理参考图');
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);
                    const resized = canvas.toDataURL('image/jpeg', 0.86);
                    if (!/^data:image\/jpeg;base64,/.test(resized)) throw new Error('参考图压缩失败');
                    resolve(resized);
                } catch {
                    reject(new Error('参考图处理失败，请换一张 PNG / JPG / WebP 图片'));
                }
            };
            image.onerror = () => reject(new Error('参考图无法读取，请使用有效的 PNG / JPG / WebP 图片'));
            image.src = dataUrl;
        });
    }

    async function fromFile(file) {
        if (!/^image\/(?:png|jpe?g|webp)$/i.test(file.type)) throw new Error('参考图仅支持 PNG / JPG / WebP 图片');
        if (!file.size || file.size > MAX_REFERENCE_FILE_BYTES) throw new Error('单张参考图不能超过 20MB，请换成更小的图片');
        return { dataUrl: await shrink(await read(file)), name: file.name || '' };
    }

    async function fromUrl(source) {
        const response = await fetchImpl(source);
        if (!response.ok) throw new Error('这张图读取失败，可先下载再手动上传');
        const blob = await response.blob();
        if (!blob.size || blob.size > MAX_REFERENCE_FILE_BYTES) throw new Error('这张图片超过 20MB，请下载并缩小后再上传');
        return { dataUrl: await shrink(await read(blob)), name: '生成结果' };
    }

    return { fromFile, fromUrl };
}
