export const UNCONFIRMED_ANSWER = '这部分暂时无法确认。';

export function wantsSourceComparison(question) {
    return /资料|来源|文档|记忆库|知识库|库内|口径/.test(question)
        && (/比较|对比/.test(question) || /列出|检查|核对|分析|哪些|什么|有何/.test(question)
            && /冲突|矛盾|不一致|差异|区别|不同/.test(question));
}

const sourceNotice = /^(?:(?:提示|注意|说明)[:：]\s*)?(?:库内(?:存在|发现|有)[^。！？\n]{0,220}(?:口径冲突|说法不一致)|(?:当前|现有|本次|检索到的)?(?:资料库|知识库|记忆库|资料|来源|文档|口径)(?:中|内|之间|的)?(?:存在|发现|出现|有)[^。！？\n]{0,220}(?:冲突|矛盾|不一致))(?=[：:，,。！？\s]|$)/;
const omissionNotice = /^部分内容缺少充分依据[，,]\s*已省略[。.]?$/;
const plainText = text => String(text || '').replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)、]\s+)/gm, '')
    .replace(/\*\*|__/g, '').replace(/\[\d+\]/g, '').trim();

// Match narration about the answer pipeline, never the business word "冲突"
// on its own (for example, a project's conflict-resolution instructions).
export function isInternalAnswerNotice(text) {
    const plain = plainText(text);
    return omissionNotice.test(plain) || plain.split(/[。！？\n]/).some(sentence => sourceNotice.test(sentence.trim()));
}

export function presentAnswerText(text) {
    const original = String(text || '');
    let fence = null, changed = false;
    const blocks = original.split(/\r?\n\s*\r?\n/).filter(block => {
        let code = Boolean(fence);
        for (const line of block.split(/\r?\n/)) {
            const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
            if (!marker) continue;
            code = true;
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
        // Historical text is not re-verified here. Only omit a standalone
        // diagnostic paragraph; never cut a mixed business quote mid-paragraph.
        const plain = plainText(block);
        const singleNotice = sourceNotice.test(plain) && plain.split(/[。！？\n]/).filter(sentence => sentence.trim()).length === 1;
        if (!code && (omissionNotice.test(plain) || singleNotice)) { changed = true; return false; }
        return true;
    });
    return changed ? blocks.join('\n\n').trim() || UNCONFIRMED_ANSWER : original;
}

// The server appends " [n]" to an evidence-backed paragraph. Hide only that
// suffix when its number is present in this message's citation metadata.
// Brackets in source text are escaped by the answer builder; code, links,
// list labels and numbers which are not citations must remain copyable.
export function stripAnswerCitations(text, citationNumbers = []) {
    const known = new Set(citationNumbers.filter(number => Number.isSafeInteger(number) && number > 0));
    const original = String(text || '');
    if (!known.size) return original;
    let fence = null, inlineTicks = 0, htmlCode = null;
    const projected = original.split(/(\r?\n)/).map(line => {
        if (/^\r?\n$/.test(line)) return line;
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
            return line;
        }
        if (marker && !inlineTicks) { fence = marker[1]; return line; }
        if (htmlCode) {
            if (new RegExp('</' + htmlCode + '\\s*>', 'i').test(line)) htmlCode = null;
            return line;
        }
        const htmlOpen = /<(pre|code)\b/i.exec(line);
        if (htmlOpen) {
            if (!new RegExp('</' + htmlOpen[1] + '\\s*>', 'i').test(line)) htmlCode = htmlOpen[1];
            return line;
        }
        if (/^(?: {4}|\t|\s*>)/.test(line)) return line;
        const suffix = /(?:[ \t]+\[\d+\])+[ \t]*$/.exec(line);
        let suffixInCode = Boolean(inlineTicks);
        for (const ticks of line.matchAll(/(?<!\\)`+/g)) {
            if (ticks.index >= (suffix?.index ?? line.length)) break;
            if (!inlineTicks) inlineTicks = ticks[0].length;
            else if (inlineTicks === ticks[0].length) inlineTicks = 0;
            suffixInCode = Boolean(inlineTicks);
        }
        if (!suffix || suffixInCode) return line;
        const prefix = line.slice(0, suffix.index);
        if (/^(?:[-*+]|\d+[.)]|>)$/.test(prefix.trim())) return line;
        const cleaned = suffix[0].replace(/[ \t]+\[(\d+)\]/g, (token, number) => known.has(Number(number)) ? '' : token);
        if (cleaned === suffix[0]) return line;
        const visible = prefix + cleaned.trimEnd();
        return visible.trim() ? visible : null;
    });
    return projected.map((line, index) => line === null || /^\r?\n$/.test(line)
        && (projected[index - 1] === null || index === projected.length - 2 && projected[index + 1] === null) ? '' : line).join('');
}
