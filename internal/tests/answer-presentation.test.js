import test from 'node:test';
import assert from 'node:assert/strict';
import {isInternalAnswerNotice,presentAnswerText,wantsSourceComparison,UNCONFIRMED_ANSWER} from '../shared/answer-presentation.js';
import {answerVisibleContent,groundingPresentation} from '../src/grounding-state.js';

const diagnostic='库内存在配送方式的口径冲突：一说只支持自提，一说可以配送。 [4]';
const footer='部分内容缺少充分依据，已省略。';
const original='门店先核对资料，再开展工作。 [1]\n\n'+diagnostic+'\n\n'+footer;

test('old answer display and copy projection remove internal notices without rewriting the stored text',()=>{
    const message={role:'assistant',content:original,metadata:{grounding:{status:'partial',citations:[{id:'kept',number:1},{id:'removed',number:4}]}}};
    assert.equal(answerVisibleContent(message),'门店先核对资料，再开展工作。 [1]');
    assert.deepEqual(groundingPresentation(message).citations.map(c=>c.id),['kept']);
    assert.equal(message.content,original);
    assert.equal(message.metadata.grounding.status,'partial');
    assert.equal(answerVisibleContent(message,{audit:true}),original);
    assert.equal(groundingPresentation(message,{audit:true}).citations.length,2);
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
