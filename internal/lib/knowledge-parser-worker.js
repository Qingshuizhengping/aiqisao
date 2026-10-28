import { parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';

const MAX_TEXT = 200000;
const MAX_EXPANDED = 12 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
function invalid(code = 'KNOWLEDGE_PARSE_FAILED') { const error = new Error(code); error.code = code; throw error; }
function checkedText(value) {
    const text = String(value).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    if (text.length > MAX_TEXT) invalid('KNOWLEDGE_TEXT_LIMIT');
    if (!text || !/[\p{L}\p{N}]/u.test(text)) invalid('KNOWLEDGE_NO_TEXT');
    return text;
}
function decode(bytes) {
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { invalid('KNOWLEDGE_ENCODING'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid('KNOWLEDGE_BINARY_FILE');
    return text;
}
function entity(text) {
    return text.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, value => {
        const common = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        if (common[value]) return common[value];
        const number = value.startsWith('&#x') ? parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1));
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
    });
}
// Office ZIP containers are never extracted to disk. Bounds are checked against the
// central directory and zlib independently, so forged expanded sizes cannot bypass limits.
function officeEntries(bytes, type) {
    const data = Buffer.from(bytes);
    let end = -1;
    for (let position = data.length - 22; position >= Math.max(0, data.length - 65557); position--) {
        if (data.readUInt32LE(position) === 0x06054b50 && position + 22 + data.readUInt16LE(position + 20) === data.length) { end = position; break; }
    }
    if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) invalid();
    const count = data.readUInt16LE(end + 10);
    const directorySize = data.readUInt32LE(end + 12);
    let position = data.readUInt32LE(end + 16);
    if (count > 2048 || !count || position + directorySize !== end) invalid('KNOWLEDGE_ARCHIVE_LIMIT');
    const entries = new Map();
    let expanded = 0;
    for (let index = 0; index < count; index++) {
        if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50) invalid();
        const flags = data.readUInt16LE(position + 8), method = data.readUInt16LE(position + 10);
        const compressed = data.readUInt32LE(position + 20), original = data.readUInt32LE(position + 24);
        const length = data.readUInt16LE(position + 28), extra = data.readUInt16LE(position + 30), comment = data.readUInt16LE(position + 32);
        const offset = data.readUInt32LE(position + 42);
        if (position + 46 + length + extra + comment > end || flags & 1 || original === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff) invalid();
        const name = data.subarray(position + 46, position + 46 + length).toString('utf8');
        expanded += original;
        if (expanded > MAX_EXPANDED) invalid('KNOWLEDGE_ARCHIVE_LIMIT');
        const wanted = type === 'docx' ? /^word\/(?:document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(name)
            : /^xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name);
        if (wanted) {
            if (entries.has(name) || original > MAX_XML || offset + 30 > position || data.readUInt32LE(offset) !== 0x04034b50) invalid();
            const localName = data.readUInt16LE(offset + 26), localExtra = data.readUInt16LE(offset + 28);
            const start = offset + 30 + localName + localExtra;
            if (start + compressed > position || ![0, 8].includes(method)) invalid();
            const packed = data.subarray(start, start + compressed);
            const unpacked = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: MAX_XML });
            if (unpacked.length !== original || unpacked.length > MAX_XML) invalid();
            const xml = decode(unpacked);
            if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalid('KNOWLEDGE_XML_UNSAFE');
            entries.set(name, xml);
        }
        position += 46 + length + extra + comment;
    }
    if (position !== end) invalid();
    return entries;
}
function xmlTexts(xml, tag) {
    const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'g');
    return [...xml.matchAll(pattern)].map(match => entity(match[1].replace(/<[^>]*>/g, ''))).join('');
}
function word(bytes) {
    const entries = officeEntries(bytes, 'docx');
    if (!entries.has('word/document.xml')) invalid();
    const output = [];
    for (const xml of entries.values()) {
        for (const paragraph of xml.split(/<\/w:p>/)) {
            output.push(xmlTexts(paragraph.replace(/<w:tab\s*\/>/g, ' '), 'w:t'));
        }
    }
    return output.join('\n');
}
function spreadsheet(bytes) {
    const entries = officeEntries(bytes, 'xlsx');
    const strings = [...(entries.get('xl/sharedStrings.xml') || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match => xmlTexts(match[1], 't'));
    const output = [];
    let cells = 0;
    const sheets = [...entries.keys()].filter(name => /worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!sheets.length || sheets.length > 100) invalid('KNOWLEDGE_ARCHIVE_LIMIT');
    for (const name of sheets) {
        output.push('工作表 ' + name.match(/sheet(\d+)/)[1]);
        for (const row of entries.get(name).split(/<\/row>/)) {
            const values = [];
            for (const cell of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
                if (++cells > 50000) invalid('KNOWLEDGE_TEXT_LIMIT');
                const type = cell[1].match(/\bt\s*=\s*["']([^"']+)["']/)?.[1];
                const value = cell[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
                values.push(type === 's' ? strings[Number(value)] || '' : type === 'inlineStr' ? xmlTexts(cell[2], 't') : entity(value || ''));
            }
            if (values.length) output.push(values.join('\t'));
        }
    }
    return output.join('\n');
}
async function pdf(bytes) {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') invalid();
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
    // Only local bundled font/CMap resources are allowed; documents never choose URLs.
    globalThis.fetch = () => { throw new Error('Network disabled in document parser'); };
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false,
        useSystemFonts: false, disableFontFace: true, useWasm: false, useWorkerFetch: false,
        cMapUrl: path.join(base, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
        standardFontDataUrl: path.join(base, 'standard_fonts').replaceAll('\\', '/') + '/',
        disableAutoFetch: true, disableStream: true, stopAtErrors: true, verbosity: 0 });
    try {
        const document = await task.promise;
        if (document.numPages > 200) invalid('KNOWLEDGE_PAGE_LIMIT');
        const output = [];
        let length = 0;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            const content = await page.getTextContent();
            const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
            length += text.length;
            if (length > MAX_TEXT) invalid('KNOWLEDGE_TEXT_LIMIT');
            output.push(text); page.cleanup();
        }
        return output.join('\n\n');
    } catch (error) {
        if (error.name === 'PasswordException') invalid('KNOWLEDGE_PDF_PASSWORD');
        throw error;
    } finally { await task.destroy(); }
}
try {
    const bytes = Buffer.from(workerData.bytes);
    const extension = workerData.extension;
    let text;
    if (extension === 'pdf') text = await pdf(bytes);
    else if (extension === 'docx') text = word(bytes);
    else if (extension === 'xlsx') text = spreadsheet(bytes);
    else {
        text = decode(bytes);
        if (extension === 'json') { try { JSON.parse(text); } catch { invalid('KNOWLEDGE_INVALID_JSON'); } }
    }
    parentPort.postMessage({ text: checkedText(text) });
} catch (error) {
    parentPort.postMessage({ error: /^KNOWLEDGE_[A-Z_]+$/.test(error.code || '') ? error.code : 'KNOWLEDGE_PARSE_FAILED' });
}
