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
        if (!code && (omissionNotice.test(plain) || sourceNotice.test(plain))) { changed = true; return false; }
        return true;
    });
    return changed ? blocks.join('\n\n').trim() || UNCONFIRMED_ANSWER : original;
}
