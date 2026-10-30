import test from 'node:test';
import assert from 'node:assert/strict';
import {isInternalAnswerNotice,presentAnswerText,stripAnswerCitations,wantsSourceComparison,UNCONFIRMED_ANSWER} from '../shared/answer-presentation.js';
import {answerVisibleContent,groundingPresentation} from '../src/grounding-state.js';

const diagnostic='库内存在配送方式的口径冲突：一说只支持自提，一说可以配送。 [4]';
const footer='部分内容缺少充分依据，已省略。';
const original='门店先核对资料，再开展工作。 [1]\n\n'+diagnostic+'\n\n'+footer;

test('old answer display and copy projection remove internal notices without rewriting the stored text',()=>{
    const message={role:'assistant',content:original,metadata:{grounding:{status:'partial',citations:[{id:'kept',number:1},{id:'removed',number:4}]}}};
    assert.equal(answerVisibleContent(message),'门店先核对资料，再开展工作。');
    assert.deepEqual(groundingPresentation(message).citations,[]);
    assert.equal(groundingPresentation(message).status,'');
    assert.equal(message.content,original);
    assert.equal(message.metadata.grounding.status,'partial');
    assert.equal(answerVisibleContent(message,{audit:true}),original);
    assert.equal(groundingPresentation(message,{audit:true}).citations.length,2);
});

test('ordinary answer display and copy remove only known generated citation suffixes',()=>{
    const text='先核对门店工作。 [1] [2]\n\n业务中的 [1] 标签、数组 [1, 2] 和编号 [9] 均保留。 [2]\n\n保留未知编号。 [9]';
    const expected='先核对门店工作。\n\n业务中的 [1] 标签、数组 [1, 2] 和编号 [9] 均保留。\n\n保留未知编号。 [9]';
    const message={role:'assistant',content:text,metadata:{grounding:{status:'verified',citations:[{id:'a',number:1},{id:'b',number:2}]}}};
    assert.equal(answerVisibleContent(message),expected);
    assert.equal(answerVisibleContent(message,{audit:true}),text);
    assert.equal(message.content,text);
    assert.equal(message.metadata.grounding.citations.length,2);
    assert.equal(stripAnswerCitations('保留未知编号。 [9]',[1,2]),'保留未知编号。 [9]');
    assert.equal(stripAnswerCitations('没有引用元数据。 [1]'),'没有引用元数据。 [1]');
    assert.equal(stripAnswerCitations('已知与未知编号。 [1] [9]',[1]),'已知与未知编号。 [9]');
    assert.equal(stripAnswerCitations('保留未知编号。 [9]  \r\n\r\n引用内容。 [1]\r\n',[1]),'保留未知编号。 [9]  \r\n\r\n引用内容。\r\n');
});

test('citation projection preserves code, Markdown labels and escaped business brackets',()=>{
    const examples=[
        '```js\nconst value = [1];\nexample [1]\n```',
        '~~~~text\nexample [1]\n~~~~',
        '`inline [1]`',
        '`multiline\nexample [1]\ncode`',
        '    example [1]',
        '\texample [1]',
        '<pre>\nexample [1]\n</pre>',
        '<code>example [1]</code>',
        '[1](https://example.test)',
        '[1]: https://example.test',
        '![1](picture.png)',
        '- [1]',
        '1. [1]',
        '> 原文编号 [1]',
        '业务编号 \\[1\\]',
    ];
    for(const content of examples) {
        assert.equal(stripAnswerCitations(content,[1]),content,content);
        assert.equal(stripAnswerCitations(content+'\n\n正常回答。 [1]',[1]),content+'\n\n正常回答。',content);
    }
    assert.equal(stripAnswerCitations('段落 `代码 [1]`。 [1]',[1]),'段落 `代码 [1]`。');
});

test('generated citation-only lines are hidden without erasing bare business labels or unknown references',()=>{
    assert.equal(stripAnswerCitations('正文。\n [1]',[1]),'正文。');
    assert.equal(stripAnswerCitations('正文。\n [1] [2]\n\n下一段。 [2]',[1,2]),'正文。\n\n下一段。');
    assert.equal(stripAnswerCitations(' [1]',[1]),'');
    for(const content of ['正文。\n[1]','正文。\n [9]','正文。\n    [1]','正文。\n- [1]','正文。\n\\[1\\]']) {
        assert.equal(stripAnswerCitations(content,[1]),content,content);
    }
    const content='原话。\n [1]';
    const grounding={basis:'confirmed_sources',citations:[{id:'one',number:1}]};
    assert.equal(answerVisibleContent({role:'assistant',content,metadata:{grounding}}),'原话。');
    assert.equal(answerVisibleContent({role:'user',content,metadata:{grounding}}),content);
    assert.equal(answerVisibleContent({role:'assistant',content,metadata:{grounding:{...grounding,basis:'user_input'}}}),content);
    assert.equal(answerVisibleContent({role:'assistant',content,metadata:{grounding}},{audit:true}),content);
});

test('original user text, rewrites and audit stay intact even with matching citation metadata',()=>{
    const content='客户原话：请检查编号 [1]';
    const metadata={grounding:{status:'verified',basis:'user_input',citations:[{id:'one',number:1}]}};
    assert.equal(answerVisibleContent({role:'user',content,metadata}),content);
    assert.equal(answerVisibleContent({role:'assistant',content,metadata}),content);
    assert.equal(answerVisibleContent({role:'assistant',content,metadata:{grounding:{...metadata.grounding,basis:'confirmed_sources'}}},{audit:true}),content);
    const comparison={role:'assistant',content:diagnostic,metadata:{grounding:{basis:'source_comparison',citations:[{id:'record',number:4}]}}};
    assert.equal(answerVisibleContent(comparison),diagnostic.replace(' [4]',''));
});

test('business conflict instructions, warehouse collisions and fenced examples remain untouched',()=>{
    for(const text of ['成员意见冲突时，由项目管理员协调。','库内存在货架冲突时，先调整库位。','资料存在字段冲突时，先联系项目管理员。','资料冲突处理流程：保留原始记录并联系负责人。',
        '示例：\n\n```text\n'+diagnostic+'\n\n'+footer+'\n```']) {
        assert.equal(presentAnswerText(text),text);
    }
    assert.equal(isInternalAnswerNotice('**库内存在配送口径冲突：尚不能确认。** [4]'),true);
    assert.equal(presentAnswerText(diagnostic+'\n\n'+footer),UNCONFIRMED_ANSWER);
    const mixed='门店先核对资料。 [1] '+diagnostic;
    assert.equal(presentAnswerText(mixed),mixed);
    const reversed=diagnostic+' 门店先核对资料，再开展工作。 [1]';
    assert.equal(presentAnswerText(reversed),reversed);
    assert.equal(isInternalAnswerNotice(mixed),true);
});

test('user messages, explicit rewrites, requested source comparisons and untagged legacy messages retain their original text',()=>{
    for(const message of [{role:'user',content:original},{role:'assistant',content:original},
        {role:'assistant',content:original,metadata:{grounding:{basis:'user_input'}}},
        {role:'assistant',content:original,metadata:{grounding:{basis:'source_comparison'}}}]) assert.equal(answerVisibleContent(message),original);
    assert.equal(wantsSourceComparison('比较资料中配送口径的冲突记录'),true);
    assert.equal(wantsSourceComparison('请对比这两份资料'),true);
    assert.equal(wantsSourceComparison('比较两份文档'),true);
    assert.equal(wantsSourceComparison('成员意见冲突怎么办？'),false);
    assert.equal(wantsSourceComparison('门店支持什么配送方式？'),false);
});
