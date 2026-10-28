import { Worker } from 'node:worker_threads';
import { AppError } from './errors.js';

export const KNOWLEDGE_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxFiles: 40, maxCharacters: 200000,
    extensions: ['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'xlsx'] });
export const PARSER_MESSAGES = {
    KNOWLEDGE_PARSE_FAILED: '文件内容无法解析，请检查文件是否完整，或另存为 TXT、PDF、DOCX 后重试。',
    KNOWLEDGE_PARSE_TIMEOUT: '文件解析超时，请拆分文件或另存为纯文本后重试。',
    KNOWLEDGE_TEXT_LIMIT: '文件文字超过 20 万字，请拆分后再上传。',
    KNOWLEDGE_NO_TEXT: '文件中未找到可检索文字。扫描件或图片请先转为可复制的文字。',
    KNOWLEDGE_ENCODING: '文字编码无法识别，请另存为 UTF-8 后上传。',
    KNOWLEDGE_BINARY_FILE: '文件包含非文字内容，请使用受支持的文档格式。',
    KNOWLEDGE_ARCHIVE_LIMIT: '文档内容过大或结构过于复杂，请拆分或另存为纯文本。',
    KNOWLEDGE_XML_UNSAFE: '文档包含不支持的 XML 结构，请另存后再上传。',
    KNOWLEDGE_PAGE_LIMIT: 'PDF 超过 200 页，请拆分后再上传。',
    KNOWLEDGE_PDF_PASSWORD: 'PDF 受密码保护，请上传已解除保护的副本。',
    KNOWLEDGE_INVALID_JSON: 'JSON 文件格式无效，请检查后重新上传。',
    KNOWLEDGE_INDEX_FAILED: '语义索引暂未完成，已保留文字并支持关键词检索。可以重试索引。',
    KNOWLEDGE_INTERRUPTED: '文档处理因服务重启中断，请点击重试。',
};
export function parseKnowledgeFile({ name, bytes, signal, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const worker = new Worker(new URL('./knowledge-parser-worker.js', import.meta.url), {
            workerData: { extension: name.split('.').pop().toLowerCase(), bytes },
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
            stdout: true, stderr: true,
        });
        worker.stdout.resume(); worker.stderr.resume();
        let finished = false;
        function done(error, result) {
            if (finished) return;
            finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
            worker.terminate().catch(() => {});
            if (error) reject(error); else resolve(result);
        }
        function aborted() { done(signal.reason || new Error('Aborted')); }
        const timer = setTimeout(() => done(new AppError(422, 'KNOWLEDGE_PARSE_TIMEOUT', PARSER_MESSAGES.KNOWLEDGE_PARSE_TIMEOUT)), timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        worker.once('message', value => value.error ? done(new AppError(422, value.error, PARSER_MESSAGES[value.error] || PARSER_MESSAGES.KNOWLEDGE_PARSE_FAILED)) : done(null, value.text));
        worker.once('error', () => done(new AppError(422, 'KNOWLEDGE_PARSE_FAILED', PARSER_MESSAGES.KNOWLEDGE_PARSE_FAILED)));
        worker.once('exit', code => { if (!finished) done(new AppError(422, 'KNOWLEDGE_PARSE_FAILED', PARSER_MESSAGES.KNOWLEDGE_PARSE_FAILED)); });
    });
}

export function chunkKnowledgeText(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + 1200, text.length);
        if (end < text.length) {
            const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('。', end), text.lastIndexOf('. ', end));
            if (boundary > start + 600) end = boundary + 1;
        }
        const content = text.slice(start, end).trim();
        if (content) chunks.push(content);
        if (end >= text.length) break;
        start = Math.max(start + 1, end - 160);
    }
    return chunks;
}
